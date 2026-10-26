// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package fs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/charlievieth/fastwalk"
)

const (
	defaultFuzzyMaxResults = 100
	fileIndexFreshTTL      = 30 * time.Second
	fileIndexStaleMaxAge   = 10 * time.Minute
	maxDPTargetLen         = 256
	maxDPQueryLen          = 64
	negInfScore            = -1_000_000_000
)

// FuzzyFindOptions configures fuzzy file search under BaseDir.
type FuzzyFindOptions struct {
	Context    context.Context `json:"-"`
	BaseDir    string          `json:"baseDir"`
	Query      string          `json:"query"`
	MaxResults int             `json:"maxResults,omitempty"`
	Excludes   []string        `json:"excludes,omitempty"`
	MaxDirs    int             `json:"maxDirs,omitempty"`
	Timeout    time.Duration   `json:"-"`
}

// FuzzyFileMatch represents a ranked file match from FuzzyFindFiles.
type FuzzyFileMatch struct {
	Path    string `json:"path"`
	RelPath string `json:"relPath"`
	Score   int    `json:"score"`
}

type indexedFile struct {
	relPath    string
	baseOffset int32
	depth      int16
	pathMask   uint64
	baseMask   uint64
}

type fileIndexCacheEntry struct {
	mu           sync.Mutex
	files        []indexedFile
	shallow      []indexedFile
	builtAt      time.Time
	building     bool
	refreshingBg bool
	buildDone    chan struct{}
	buildErr     error
}

var asciiBitTable [256]uint64
var asciiLowerTable [256]byte

func init() {
	for i := 0; i < 256; i++ {
		asciiLowerTable[i] = byte(i)
	}
	for c := byte('a'); c <= 'z'; c++ {
		bit := uint64(1) << (c - 'a')
		asciiBitTable[c] = bit
		upper := c - ('a' - 'A')
		asciiBitTable[upper] = bit
		asciiLowerTable[upper] = c
	}
	for c := byte('0'); c <= '9'; c++ {
		asciiBitTable[c] = uint64(1) << (26 + (c - '0'))
	}
	asciiBitTable['_'] = uint64(1) << 36
	asciiBitTable['-'] = uint64(1) << 37
	asciiBitTable['.'] = uint64(1) << 38
	asciiBitTable['/'] = uint64(1) << 39
}

func makeIndexedFile(relPathSlash string) indexedFile {
	var pMask, bMask uint64
	var lastSlash int32 = -1
	var depth int16
	for i := 0; i < len(relPathSlash); i++ {
		c := relPathSlash[i]
		bit := asciiBitTable[c]
		pMask |= bit
		if c == '/' {
			lastSlash = int32(i)
			bMask = 0
			depth++
		} else {
			bMask |= bit
		}
	}
	return indexedFile{
		relPath:    relPathSlash,
		baseOffset: lastSlash + 1,
		depth:      depth,
		pathMask:   pMask,
		baseMask:   bMask,
	}
}

// InvalidateFileIndex marks all cached file indexes stale so the next search refreshes.
func (sm *SandboxManager) InvalidateFileIndex() {
	sm.indexMu.Lock()
	defer sm.indexMu.Unlock()
	for _, entry := range sm.fileIndex {
		entry.mu.Lock()
		entry.builtAt = time.Time{}
		entry.mu.Unlock()
	}
}

// WarmFileIndex asynchronously builds or refreshes the fuzzy file index for baseDir if not already fresh.
func (sm *SandboxManager) WarmFileIndex(ctx context.Context, baseDir string) {
	validBaseDir, err := sm.ValidatePath(baseDir)
	if err != nil {
		return
	}
	go func() {
		_, _ = sm.FuzzyFindFiles(FuzzyFindOptions{
			Context:    ctx,
			BaseDir:    validBaseDir,
			Query:      "",
			MaxResults: 1,
		})
	}()
}

func sortIndexedFilesByDepth(files []indexedFile) {
	sort.Slice(files, func(i, j int) bool {
		if files[i].depth != files[j].depth {
			return files[i].depth < files[j].depth
		}
		if len(files[i].relPath) != len(files[j].relPath) {
			return len(files[i].relPath) < len(files[j].relPath)
		}
		return files[i].relPath < files[j].relPath
	})
}

type indexShard struct {
	mu    sync.Mutex
	files []indexedFile
}

func loadRootGitIgnorePaths(validBaseDir string) map[string]bool {
	data, err := os.ReadFile(filepath.Join(validBaseDir, ".gitignore"))
	if err != nil {
		return nil
	}
	paths := make(map[string]bool)
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "!") {
			continue
		}
		if strings.HasPrefix(trimmed, "/") || strings.Contains(strings.Trim(trimmed, "/"), "/") {
			clean := strings.Trim(trimmed, "/")
			clean = strings.TrimSuffix(clean, "/**")
			if clean != "" && !strings.ContainsAny(clean, "*?[") {
				paths[clean] = true
			}
		}
	}
	return paths
}

func (sm *SandboxManager) buildFileIndex(ctx context.Context, validBaseDir string, maxDirs int, timeout time.Duration) ([]indexedFile, []indexedFile, bool, error) {
	if maxDirs <= 0 {
		maxDirs = DefaultMaxFindDirs
	}
	if timeout <= 0 {
		timeout = DefaultMaxFindTimeout
	}
	if ctx == nil {
		ctx = context.Background()
	}
	walkCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	rootGitIgnorePaths := loadRootGitIgnorePaths(validBaseDir)

	const numShards = 64
	var shards [numShards]indexShard
	var dirsVisited atomic.Int64
	var shardCounter atomic.Uint64

	prefixLen := len(validBaseDir)
	if !strings.HasSuffix(validBaseDir, string(filepath.Separator)) {
		prefixLen++
	}

	conf := fastwalk.Config{
		Follow: false,
	}

	walkErr := fastwalk.Walk(&conf, validBaseDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if walkCtx.Err() != nil {
			return errLimitExceeded
		}
		if path == validBaseDir || len(path) <= prefixLen {
			return nil
		}

		relPathSlash := filepath.ToSlash(path[prefixLen:])
		name := d.Name()

		if d.IsDir() {
			if isBuiltInExcludedDir(name, relPathSlash, false) || rootGitIgnorePaths[relPathSlash] {
				return fastwalk.SkipDir
			}
			if dirsVisited.Add(1) > int64(maxDirs) {
				return errLimitExceeded
			}
			return nil
		}

		entry := makeIndexedFile(relPathSlash)
		idx := shardCounter.Add(1) & (numShards - 1)
		sh := &shards[idx]
		sh.mu.Lock()
		sh.files = append(sh.files, entry)
		sh.mu.Unlock()
		return nil
	})

	if ctx.Err() != nil {
		return nil, nil, false, ctx.Err()
	}
	if walkErr != nil && !errors.Is(walkErr, errStop) && !errors.Is(walkErr, errLimitExceeded) {
		return nil, nil, false, walkErr
	}
	complete := !errors.Is(walkErr, errLimitExceeded)

	total := 0
	for i := range shards {
		total += len(shards[i].files)
	}
	files := make([]indexedFile, 0, total)
	for i := range shards {
		files = append(files, shards[i].files...)
	}
	if len(files) == 0 {
		complete = false
	}

	var shallow []indexedFile
	if len(files) <= 4096 {
		sortIndexedFilesByDepth(files)
		shallow = files
	} else {
		shallow = make([]indexedFile, 0, 1024)
		for _, f := range files {
			if f.depth <= 1 {
				shallow = append(shallow, f)
			}
		}
		if len(shallow) < 512 {
			for _, f := range files {
				if f.depth == 2 {
					shallow = append(shallow, f)
				}
			}
		}
		sortIndexedFilesByDepth(shallow)
		if len(shallow) > 1024 {
			shallow = shallow[:1024]
		}
	}

	return files, shallow, complete, nil
}

func (sm *SandboxManager) getOrBuildFileIndex(opts FuzzyFindOptions, validBaseDir string) ([]indexedFile, []indexedFile, error) {
	cacheKey := validBaseDir

	sm.indexMu.Lock()
	if sm.fileIndex == nil {
		sm.fileIndex = make(map[string]*fileIndexCacheEntry)
	}
	entry, ok := sm.fileIndex[cacheKey]
	if !ok {
		entry = &fileIndexCacheEntry{}
		sm.fileIndex[cacheKey] = entry
	}
	sm.indexMu.Unlock()

	for {
		entry.mu.Lock()
		age := time.Since(entry.builtAt)
		freshTTL := fileIndexFreshTTL
		if len(entry.files) < 5000 {
			freshTTL = 500 * time.Millisecond
		}
		if len(entry.files) > 0 && !entry.builtAt.IsZero() && age < freshTTL {
			files := entry.files
			shallow := entry.shallow
			entry.mu.Unlock()
			return files, shallow, nil
		}

		// Stale-while-revalidate for already-populated large indexes so searches stay instant.
		if len(entry.files) >= 5000 && !entry.builtAt.IsZero() && age < fileIndexStaleMaxAge {
			files := entry.files
			shallow := entry.shallow
			if !entry.building && !entry.refreshingBg {
				entry.refreshingBg = true
				maxDirs := opts.MaxDirs
				timeout := opts.Timeout
				go func() {
					newFiles, newShallow, complete, err := sm.buildFileIndex(context.Background(), validBaseDir, maxDirs, timeout)
					entry.mu.Lock()
					entry.refreshingBg = false
					if err == nil && complete {
						entry.files = newFiles
						entry.shallow = newShallow
						entry.builtAt = time.Now()
					}
					entry.mu.Unlock()
				}()
			}
			entry.mu.Unlock()
			return files, shallow, nil
		}

		if !entry.building {
			entry.building = true
			done := make(chan struct{})
			entry.buildDone = done
			maxDirs := opts.MaxDirs
			timeout := opts.Timeout
			go func() {
				files, shallow, complete, err := sm.buildFileIndex(context.Background(), validBaseDir, maxDirs, timeout)
				entry.mu.Lock()
				entry.building = false
				entry.buildErr = err
				if err == nil {
					entry.files = files
					entry.shallow = shallow
					if complete {
						entry.builtAt = time.Now()
					} else {
						entry.builtAt = time.Time{}
					}
				}
				close(done)
				entry.mu.Unlock()
			}()
		}

		done := entry.buildDone
		entry.mu.Unlock()
		if opts.Context != nil {
			select {
			case <-done:
			case <-opts.Context.Done():
				return nil, nil, opts.Context.Err()
			}
		} else {
			<-done
		}
		entry.mu.Lock()
		files := entry.files
		shallow := entry.shallow
		err := entry.buildErr
		entry.mu.Unlock()
		return files, shallow, err
	}
}

type queryToken struct {
	raw        string
	lower      string
	suffixRaw  string
	suffixLow  string
	mask       uint64
	suffixMask uint64
	hasSlash   bool
}

func parseQueryTokens(query string) []queryToken {
	fields := strings.Fields(query)
	if len(fields) == 0 {
		return nil
	}
	tokens := make([]queryToken, 0, len(fields))
	for _, f := range fields {
		norm := strings.ReplaceAll(f, "\\", "/")
		norm = strings.TrimPrefix(norm, "./")
		norm = strings.TrimPrefix(norm, "/")
		norm = strings.TrimSuffix(norm, "/")
		if norm == "" {
			continue
		}
		lower := strings.ToLower(norm)
		mask, baseMask, baseOff := makeIndexedFileMaskOnly(lower)
		tokens = append(tokens, queryToken{
			raw:        norm,
			lower:      lower,
			suffixRaw:  norm[baseOff:],
			suffixLow:  lower[baseOff:],
			mask:       mask,
			suffixMask: baseMask,
			hasSlash:   strings.IndexByte(lower, '/') >= 0,
		})
	}
	return tokens
}

func makeIndexedFileMaskOnly(s string) (pathMask uint64, baseMask uint64, baseOffset int32) {
	var pMask, bMask uint64
	var lastSlash int32 = -1
	for i := 0; i < len(s); i++ {
		c := s[i]
		bit := asciiBitTable[c]
		pMask |= bit
		if c == '/' {
			lastSlash = int32(i)
			bMask = 0
		} else {
			bMask |= bit
		}
	}
	return pMask, bMask, lastSlash + 1
}

// FuzzyFindFiles searches for files under opts.BaseDir matching opts.Query with VS Code-style fuzzy ranking.
func (sm *SandboxManager) FuzzyFindFiles(opts FuzzyFindOptions) ([]FuzzyFileMatch, error) {
	baseDir := opts.BaseDir
	if baseDir == "" {
		baseDir = sm.repoRoot
	}
	validBaseDir, err := sm.ValidatePath(baseDir)
	if err != nil {
		return nil, err
	}

	maxResults := opts.MaxResults
	if maxResults <= 0 {
		maxResults = defaultFuzzyMaxResults
	}

	cleanBaseDir := filepath.Clean(baseDir)
	files, shallow, err := sm.getOrBuildFileIndex(opts, validBaseDir)
	if err != nil {
		return nil, err
	}

	excludes := parseExcludes(opts.Excludes, validBaseDir, cleanBaseDir)
	hasExcludes := !excludes.isEmpty()

	tokens := parseQueryTokens(opts.Query)
	if len(tokens) == 0 {
		source := shallow
		if len(source) == 0 {
			source = files
		}
		out := make([]FuzzyFileMatch, 0, maxResults)
		for i := 0; i < len(source) && len(out) < maxResults; i++ {
			f := source[i]
			if hasExcludes && isExcludedRelPath(f.relPath, f.baseOffset, excludes) {
				continue
			}
			out = append(out, FuzzyFileMatch{
				Path:    filepath.Join(validBaseDir, filepath.FromSlash(f.relPath)),
				RelPath: f.relPath,
				Score:   0,
			})
		}
		return out, nil
	}

	var combinedPathMask uint64
	var requiredBaseMask uint64
	for i := range tokens {
		combinedPathMask |= tokens[i].mask
		if tokens[i].hasSlash {
			requiredBaseMask |= tokens[i].suffixMask
		}
	}

	numWorkers := runtime.GOMAXPROCS(0)
	if numWorkers < 1 {
		numWorkers = 1
	}
	if len(files) < 2048 {
		numWorkers = 1
	} else if numWorkers > 16 {
		numWorkers = 16
	}

	workerMatches := make([][]scoredIndex, numWorkers)
	chunkSize := (len(files) + numWorkers - 1) / numWorkers

	var wg sync.WaitGroup
	for w := 0; w < numWorkers; w++ {
		start := w * chunkSize
		if start >= len(files) {
			break
		}
		end := start + chunkSize
		if end > len(files) {
			end = len(files)
		}
		wg.Add(1)
		go func(workerID, s, e int) {
			defer wg.Done()
			local := make([]scoredIndex, 0, maxResults*2)
			minScore := negInfScore

			for idx := s; idx < e; idx++ {
				f := files[idx]
				if (f.pathMask & combinedPathMask) != combinedPathMask {
					continue
				}
				if requiredBaseMask != 0 && (f.baseMask&requiredBaseMask) != requiredBaseMask {
					continue
				}
				score, ok := scoreIndexedFile(f, tokens)
				if !ok {
					continue
				}
				if len(local) < maxResults || score > minScore {
					if hasExcludes && isExcludedRelPath(f.relPath, f.baseOffset, excludes) {
						continue
					}
					local = append(local, scoredIndex{idx: idx, score: score})
					if len(local) >= maxResults*2 {
						sortScoredIndices(local, files)
						local = local[:maxResults]
						minScore = local[maxResults-1].score
					}
				}
			}
			if len(local) > maxResults {
				sortScoredIndices(local, files)
				local = local[:maxResults]
			}
			workerMatches[workerID] = local
		}(w, start, end)
	}
	wg.Wait()

	totalMatches := 0
	for _, m := range workerMatches {
		totalMatches += len(m)
	}
	merged := make([]scoredIndex, 0, totalMatches)
	for _, m := range workerMatches {
		merged = append(merged, m...)
	}

	sortScoredIndices(merged, files)
	if len(merged) > maxResults {
		merged = merged[:maxResults]
	}

	results := make([]FuzzyFileMatch, len(merged))
	for i, m := range merged {
		f := files[m.idx]
		results[i] = FuzzyFileMatch{
			Path:    filepath.Join(validBaseDir, filepath.FromSlash(f.relPath)),
			RelPath: f.relPath,
			Score:   m.score,
		}
	}
	return results, nil
}

type scoredIndex struct {
	idx   int
	score int
}

func sortScoredIndices(items []scoredIndex, files []indexedFile) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].score != items[j].score {
			return items[i].score > items[j].score
		}
		fi := files[items[i].idx]
		fj := files[items[j].idx]
		baseLenI := len(fi.relPath) - int(fi.baseOffset)
		baseLenJ := len(fj.relPath) - int(fj.baseOffset)
		if baseLenI != baseLenJ {
			return baseLenI < baseLenJ
		}
		if len(fi.relPath) != len(fj.relPath) {
			return len(fi.relPath) < len(fj.relPath)
		}
		return fi.relPath < fj.relPath
	})
}

func scoreIndexedFile(f indexedFile, tokens []queryToken) (int, bool) {
	total := 0
	for i := range tokens {
		tok := tokens[i]
		s, ok := scoreSingleToken(f, tok)
		if !ok {
			return 0, false
		}
		total += s
	}
	return total - len(f.relPath)*2 - int(f.depth)*15, true
}

func scoreSingleToken(f indexedFile, tok queryToken) (int, bool) {
	basename := f.relPath[f.baseOffset:]

	// 1. Slash-less token: match fuzzy in basename OR contiguous substring in directory path
	if !tok.hasSlash {
		if (f.baseMask & tok.mask) == tok.mask {
			if baseScore, ok := scoreAlignment(basename, 0, tok.raw, tok.lower, true); ok {
				return baseScore, true
			}
		}
		// Fallback for directory-name tokens (e.g. "chrome" in "chrome browser_view.cc"):
		// require a contiguous case-insensitive substring match in the directory path.
		if f.baseOffset > 0 {
			dirPart := f.relPath[:f.baseOffset-1]
			if pos := indexIgnoreCaseASCII(dirPart, tok.lower); pos >= 0 {
				dirScore := 1200 + len(tok.lower)*60
				if pos == 0 || dirPart[pos-1] == '/' {
					dirScore += 500
				}
				if pos+len(tok.lower) == len(dirPart) || dirPart[pos+len(tok.lower)] == '/' {
					dirScore += 500
				}
				return dirScore, true
			}
		}
		return 0, false
	}

	// 2. Slash-containing token (e.g. "frame/browser_view.cc"):
	// Suffix after last '/' must match in basename.
	if len(tok.suffixLow) > 0 {
		if (f.baseMask & tok.suffixMask) != tok.suffixMask {
			return 0, false
		}
		if _, ok := scoreAlignment(basename, 0, tok.suffixRaw, tok.suffixLow, true); !ok {
			return 0, false
		}
	}

	pathScore, ok := scoreAlignment(f.relPath, int(f.baseOffset), tok.raw, tok.lower, false)
	if !ok {
		return 0, false
	}

	if len(tok.suffixLow) > 0 {
		if len(basename) == len(tok.suffixLow) && equalsIgnoreCaseASCII(basename, tok.suffixLow) {
			pathScore += 40000
		} else if indexIgnoreCaseASCII(basename, tok.suffixLow) >= 0 {
			pathScore += 12000
		}
	}

	return pathScore, true
}

func indexIgnoreCaseASCII(s, substrLower string) int {
	n := len(s)
	m := len(substrLower)
	if m == 0 {
		return 0
	}
	if m > n {
		return -1
	}
	first := substrLower[0]
	limit := n - m
	for i := 0; i <= limit; i++ {
		if asciiLowerTable[s[i]] != first {
			continue
		}
		match := true
		for j := 1; j < m; j++ {
			if asciiLowerTable[s[i+j]] != substrLower[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func equalsIgnoreCaseASCII(a, bLower string) bool {
	if len(a) != len(bLower) {
		return false
	}
	for i := 0; i < len(a); i++ {
		if asciiLowerTable[a[i]] != bLower[i] {
			return false
		}
	}
	return true
}

func isWordBoundary(target string, j int, baseOffset int) bool {
	if j == 0 || j == baseOffset {
		return true
	}
	prev := target[j-1]
	if prev == '/' || prev == '_' || prev == '-' || prev == '.' || prev == ' ' {
		return true
	}
	curr := target[j]
	return prev >= 'a' && prev <= 'z' && curr >= 'A' && curr <= 'Z'
}

func charPositionBonus(target string, j int, baseOffset int, exactCase bool) int {
	bonus := 30
	if j >= baseOffset {
		bonus = 100
	}
	if exactCase {
		bonus += 15
	}
	if j == baseOffset {
		return bonus + 600
	}
	if j == 0 {
		return bonus + 150
	}
	prev := target[j-1]
	curr := target[j]
	if prev == '/' {
		return bonus + 140
	}
	if prev == '_' || prev == '-' || prev == '.' || prev == ' ' {
		if j > baseOffset {
			return bonus + 300
		}
		return bonus + 90
	}
	if prev >= 'a' && prev <= 'z' && curr >= 'A' && curr <= 'Z' {
		if j > baseOffset {
			return bonus + 280
		}
		return bonus + 80
	}
	return bonus
}

// scoreAlignment finds the optimal fuzzy alignment score of qLower within target.
func scoreAlignment(target string, baseOffset int, qRaw, qLower string, isBasenameOnly bool) (int, bool) {
	m := len(qLower)
	n := len(target)
	if m == 0 || m > n {
		return 0, false
	}

	// Fast-path for exact filename match
	if isBasenameOnly && n == m {
		if !equalsIgnoreCaseASCII(target, qLower) {
			return 0, false
		}
		score := 50000 + m*300
		if target == qRaw {
			score += 500
		}
		return score, true
	}

	// Fast forward pass: verify subsequence and locate earliest start
	qi := 0
	firstMatch := -1
	for ti := 0; ti < n && qi < m; ti++ {
		if asciiLowerTable[target[ti]] == qLower[qi] {
			if qi == 0 {
				firstMatch = ti
			}
			qi++
		}
	}
	if qi < m {
		return 0, false
	}

	// Fast backward pass: locate latest end
	qi = m - 1
	lastMatch := -1
	for ti := n - 1; ti >= firstMatch && qi >= 0; ti-- {
		if asciiLowerTable[target[ti]] == qLower[qi] {
			if qi == m-1 {
				lastMatch = ti
			}
			qi--
		}
	}

	spanLen := lastMatch - firstMatch + 1
	if m > maxDPQueryLen || spanLen > maxDPTargetLen {
		return scoreGreedyFallback(target, baseOffset, qRaw, qLower, firstMatch, isBasenameOnly), true
	}

	var prevM [maxDPTargetLen]int
	var currM [maxDPTargetLen]int

	const gapPenalty = 8

	// Row 0: matching qLower[0]
	maxJ0 := lastMatch - (m - 1)
	for j := firstMatch; j <= lastMatch; j++ {
		idx := j - firstMatch
		if j <= maxJ0 && asciiLowerTable[target[j]] == qLower[0] {
			b := charPositionBonus(target, j, baseOffset, target[j] == qRaw[0]) - (j-baseOffset)*3
			if !isWordBoundary(target, j, baseOffset) {
				b -= 260
			}
			prevM[idx] = b
		} else {
			prevM[idx] = negInfScore
		}
	}

	// Rows 1 .. m-1
	for i := 1; i < m; i++ {
		qCharLow := qLower[i]
		qCharRaw := qRaw[i]
		minJ := firstMatch + i
		maxJ := lastMatch - (m - 1 - i)

		bestGapScore := negInfScore
		currM[minJ-1-firstMatch] = negInfScore

		for j := minJ; j <= maxJ; j++ {
			idx := j - firstMatch
			prevAtJMinus1 := prevM[idx-1]

			if asciiLowerTable[target[j]] == qCharLow {
				posBonus := charPositionBonus(target, j, baseOffset, target[j] == qCharRaw)
				bestHere := negInfScore

				if prevAtJMinus1 > negInfScore/2 {
					consecBonus := 90
					if j > baseOffset {
						consecBonus = 180
					}
					bestHere = prevAtJMinus1 + posBonus + consecBonus
				}
				if bestGapScore > negInfScore/2 {
					gapCandidate := bestGapScore + posBonus
					if !isWordBoundary(target, j, baseOffset) {
						gapCandidate -= 260
					}
					if gapCandidate > bestHere {
						bestHere = gapCandidate
					}
				}
				currM[idx] = bestHere
			} else {
				currM[idx] = negInfScore
			}

			if prevAtJMinus1 > bestGapScore {
				bestGapScore = prevAtJMinus1
			}
			if bestGapScore > negInfScore/2 {
				bestGapScore -= gapPenalty
			}
		}

		for j := minJ; j <= maxJ; j++ {
			idx := j - firstMatch
			prevM[idx] = currM[idx]
		}
	}

	bestScore := negInfScore
	minLastJ := firstMatch + m - 1
	for j := minLastJ; j <= lastMatch; j++ {
		s := prevM[j-firstMatch]
		if s > bestScore {
			bestScore = s
		}
	}

	if isBasenameOnly {
		bestScore += 4000 - (n-m)*15
		if subPos := indexIgnoreCaseASCII(target, qLower); subPos >= 0 {
			if subPos == 0 {
				bestScore += 20000
			} else if isWordBoundary(target, subPos, 0) {
				bestScore += 12000
			}
		}
	}

	return bestScore, true
}

func scoreGreedyFallback(target string, baseOffset int, qRaw, qLower string, firstMatch int, isBasenameOnly bool) int {
	m := len(qLower)
	n := len(target)
	score := 0
	qi := 0
	prevMatchedIdx := -2
	for ti := firstMatch; ti < n && qi < m; ti++ {
		if asciiLowerTable[target[ti]] == qLower[qi] {
			score += charPositionBonus(target, ti, baseOffset, target[ti] == qRaw[qi])
			if prevMatchedIdx == ti-1 {
				if ti > baseOffset {
					score += 180
				} else {
					score += 90
				}
			} else if prevMatchedIdx >= 0 {
				score -= (ti - prevMatchedIdx - 1) * 8
			}
			prevMatchedIdx = ti
			qi++
		}
	}
	if isBasenameOnly {
		score += 4000 - (n-m)*15
	}
	return score
}

