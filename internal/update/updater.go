// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

package update

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultReleasesURL is the GitHub Releases API endpoint for jj-view.
	DefaultReleasesURL = "https://api.github.com/repos/brychanrobot/jj-view/releases"

	// DefaultCacheTTL is the default duration for caching release check results.
	DefaultCacheTTL = 15 * time.Minute

	maxMetadataBytes     = 4 * 1024 * 1024   // 4 MB limit for releases JSON and checksums.txt
	maxReleaseAssetBytes = 250 * 1024 * 1024 // 250 MB limit for binary asset
	maxRedirects         = 10
	reloadDelay          = 150 * time.Millisecond
)

// Options configures an Updater instance.
type Options struct {
	CurrentVersion string
	ReleaseAsset   string
	ExecutablePath string
	ReleasesURL    string
	HTTPClient     *http.Client
	CacheTTL       time.Duration
	Now            func() time.Time
	OnReload       func() error
}

// CheckOptions configures an update check request.
type CheckOptions struct {
	Force      bool `json:"force,omitempty"`
	Prerelease bool `json:"prerelease,omitempty"`
}

// ApplyOptions configures an in-place self-update operation.
type ApplyOptions struct {
	Prerelease    bool `json:"prerelease,omitempty"`
	TriggerReload bool `json:"triggerReload,omitempty"`
}

// UpdateInfo describes the current binary version and latest available release.
type UpdateInfo struct {
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	ReleaseAsset    string `json:"releaseAsset,omitempty"`
	CanSelfUpdate   bool   `json:"canSelfUpdate"`
	UpdateAvailable bool   `json:"updateAvailable"`
	Prerelease      bool   `json:"prerelease,omitempty"`
	ReleaseURL      string `json:"releaseUrl,omitempty"`
	ReleaseNotes    string `json:"releaseNotes,omitempty"`
	PublishedAt     string `json:"publishedAt,omitempty"`
	AssetURL        string `json:"-"`
	AssetSize       int64  `json:"-"`
	ChecksumsURL    string `json:"-"`
}

// ApplyResult describes the outcome of applying an update.
type ApplyResult struct {
	PreviousVersion string `json:"previousVersion"`
	UpdatedVersion  string `json:"updatedVersion"`
	BinaryPath      string `json:"binaryPath"`
	Restarting      bool   `json:"restarting"`
}

type githubRelease struct {
	TagName     string        `json:"tag_name"`
	Draft       bool          `json:"draft"`
	Prerelease  bool          `json:"prerelease"`
	HTMLURL     string        `json:"html_url"`
	Body        string        `json:"body"`
	PublishedAt string        `json:"published_at"`
	Assets      []githubAsset `json:"assets"`
}

type githubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

// Updater checks for and applies binary self-updates from GitHub Releases.
type Updater struct {
	opts        Options
	releasesURL string
	client      *http.Client
	cacheTTL    time.Duration
	now         func() time.Time

	mu            sync.Mutex
	cachedStd     *UpdateInfo
	cachedStdAt   time.Time
	cachedPre     *UpdateInfo
	cachedPreAt   time.Time
	appliedResult *ApplyResult

	applyMu    sync.Mutex
	reloadOnce sync.Once
}

// NewUpdater creates a new Updater with the given options.
func NewUpdater(opts Options) *Updater {
	releasesURL := strings.TrimSpace(opts.ReleasesURL)
	if releasesURL == "" {
		releasesURL = DefaultReleasesURL
	}
	cacheTTL := opts.CacheTTL
	if cacheTTL <= 0 {
		cacheTTL = DefaultCacheTTL
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}

	var client *http.Client
	if opts.HTTPClient != nil {
		cp := *opts.HTTPClient
		if cp.CheckRedirect == nil {
			cp.CheckRedirect = secureCheckRedirect
		}
		client = &cp
	} else {
		client = &http.Client{
			Timeout:       5 * time.Minute,
			CheckRedirect: secureCheckRedirect,
		}
	}

	return &Updater{
		opts:        opts,
		releasesURL: releasesURL,
		client:      client,
		cacheTTL:    cacheTTL,
		now:         nowFn,
	}
}

func secureCheckRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= maxRedirects {
		return fmt.Errorf("stopped after %d redirects", maxRedirects)
	}
	if err := ValidateUpdateURL(req.URL.String()); err != nil {
		return fmt.Errorf("redirect target rejected: %w", err)
	}
	if len(via) > 0 && !strings.EqualFold(req.URL.Host, via[0].URL.Host) {
		req.Header.Del("Authorization")
		req.Header.Del("Cookie")
	}
	return nil
}

// ValidateUpdateURL ensures an update metadata or asset URL uses HTTPS, or HTTP
// strictly for loopback hosts (127.0.0.1, ::1, localhost).
func ValidateUpdateURL(rawURL string) error {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return errors.New("update URL is empty")
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return fmt.Errorf("invalid update URL: %w", err)
	}
	if u.User != nil {
		return errors.New("update URL must not contain userinfo credentials")
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("update URL is missing host")
	}

	ip := net.ParseIP(host)
	if ip != nil {
		if ip.IsUnspecified() {
			return fmt.Errorf("update URL host %q must not be an unspecified address", host)
		}
		if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return fmt.Errorf("update URL host %q must not be a link-local address", host)
		}
	}

	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "https":
		return nil
	case "http":
		if strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback()) {
			return nil
		}
		return fmt.Errorf("insecure http scheme is only allowed for loopback hosts, got %q", host)
	default:
		return fmt.Errorf("unsupported URL scheme %q", u.Scheme)
	}
}

// CanSelfUpdate reports whether this binary has both a configured release asset
// name and a resolved executable path on disk.
func (u *Updater) CanSelfUpdate() bool {
	return strings.TrimSpace(u.opts.ReleaseAsset) != "" && strings.TrimSpace(u.opts.ExecutablePath) != ""
}

func cleanVersion(v string) string {
	s := strings.TrimSpace(v)
	s = strings.TrimPrefix(s, "v")
	s = strings.TrimPrefix(s, "V")
	if s == "" {
		return "0.0.0"
	}
	return s
}

func copyUpdateInfo(info *UpdateInfo) *UpdateInfo {
	if info == nil {
		return nil
	}
	cp := *info
	return &cp
}

// Check queries the configured releases endpoint (or returns a cached result)
// to determine whether a newer version is available for this binary's asset.
func (u *Updater) Check(ctx context.Context, opts CheckOptions) (*UpdateInfo, error) {
	currentVer := cleanVersion(u.opts.CurrentVersion)
	if !u.CanSelfUpdate() {
		return &UpdateInfo{
			CurrentVersion:  currentVer,
			LatestVersion:   currentVer,
			CanSelfUpdate:   false,
			UpdateAvailable: false,
		}, nil
	}

	assetName := filepath.Base(strings.TrimSpace(u.opts.ReleaseAsset))
	now := u.now()

	u.mu.Lock()
	if u.appliedResult != nil {
		appliedVer := u.appliedResult.UpdatedVersion
		u.mu.Unlock()
		return &UpdateInfo{
			CurrentVersion:  appliedVer,
			LatestVersion:   appliedVer,
			ReleaseAsset:    assetName,
			CanSelfUpdate:   true,
			UpdateAvailable: false,
		}, nil
	}
	if !opts.Force {
		if opts.Prerelease {
			if u.cachedPre != nil && now.Sub(u.cachedPreAt) < u.cacheTTL {
				res := copyUpdateInfo(u.cachedPre)
				u.mu.Unlock()
				return res, nil
			}
		} else {
			if u.cachedStd != nil && now.Sub(u.cachedStdAt) < u.cacheTTL {
				res := copyUpdateInfo(u.cachedStd)
				u.mu.Unlock()
				return res, nil
			}
		}
	}
	u.mu.Unlock()

	if err := ValidateUpdateURL(u.releasesURL); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.releasesURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create release check request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "jj-view/"+currentVer)

	resp, err := u.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch releases: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("releases endpoint returned HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxMetadataBytes+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read releases response: %w", err)
	}
	if len(body) > maxMetadataBytes {
		return nil, fmt.Errorf("releases response exceeds maximum size of %d bytes", maxMetadataBytes)
	}

	var releases []githubRelease
	if err := json.Unmarshal(body, &releases); err != nil {
		return nil, fmt.Errorf("failed to decode releases JSON: %w", err)
	}

	var (
		bestRelease  *githubRelease
		bestVer      string
		bestAsset    *githubAsset
		bestChecksum *githubAsset
	)

	for i := range releases {
		rel := &releases[i]
		if rel.Draft {
			continue
		}
		if rel.Prerelease && !opts.Prerelease {
			continue
		}
		candidateVer := cleanVersion(rel.TagName)
		if _, err := CompareSemver(candidateVer, "0.0.0"); err != nil {
			continue
		}

		var matchedAsset *githubAsset
		var matchedChecksums *githubAsset
		for j := range rel.Assets {
			a := &rel.Assets[j]
			switch a.Name {
			case assetName:
				if a.Size > 0 && a.Size <= maxReleaseAssetBytes && ValidateUpdateURL(a.BrowserDownloadURL) == nil {
					matchedAsset = a
				}
			case "checksums.txt":
				if ValidateUpdateURL(a.BrowserDownloadURL) == nil {
					matchedChecksums = a
				}
			}
		}
		if matchedAsset == nil || matchedChecksums == nil {
			continue
		}

		if bestRelease == nil {
			bestRelease = rel
			bestVer = candidateVer
			bestAsset = matchedAsset
			bestChecksum = matchedChecksums
			continue
		}
		if cmp, err := CompareSemver(candidateVer, bestVer); err == nil && cmp > 0 {
			bestRelease = rel
			bestVer = candidateVer
			bestAsset = matchedAsset
			bestChecksum = matchedChecksums
		}
	}

	info := &UpdateInfo{
		CurrentVersion:  currentVer,
		LatestVersion:   currentVer,
		ReleaseAsset:    assetName,
		CanSelfUpdate:   true,
		UpdateAvailable: false,
	}

	if bestRelease != nil {
		cmp, err := CompareSemver(bestVer, currentVer)
		updateAvailable := err == nil && cmp > 0
		latestVer := currentVer
		if updateAvailable {
			latestVer = bestVer
		}
		releaseURL := strings.TrimSpace(bestRelease.HTMLURL)
		if releaseURL != "" && ValidateUpdateURL(releaseURL) != nil {
			releaseURL = ""
		}
		info = &UpdateInfo{
			CurrentVersion:  currentVer,
			LatestVersion:   latestVer,
			ReleaseAsset:    assetName,
			CanSelfUpdate:   true,
			UpdateAvailable: updateAvailable,
			Prerelease:      bestRelease.Prerelease,
			ReleaseURL:      releaseURL,
			ReleaseNotes:    bestRelease.Body,
			PublishedAt:     bestRelease.PublishedAt,
			AssetURL:        bestAsset.BrowserDownloadURL,
			AssetSize:       bestAsset.Size,
			ChecksumsURL:    bestChecksum.BrowserDownloadURL,
		}
	}

	u.mu.Lock()
	if u.appliedResult != nil {
		appliedVer := u.appliedResult.UpdatedVersion
		u.mu.Unlock()
		return &UpdateInfo{
			CurrentVersion:  appliedVer,
			LatestVersion:   appliedVer,
			ReleaseAsset:    assetName,
			CanSelfUpdate:   true,
			UpdateAvailable: false,
		}, nil
	}
	cachedTime := u.now()
	if opts.Prerelease {
		u.cachedPre = copyUpdateInfo(info)
		u.cachedPreAt = cachedTime
	} else {
		u.cachedStd = copyUpdateInfo(info)
		u.cachedStdAt = cachedTime
	}
	u.mu.Unlock()

	return copyUpdateInfo(info), nil
}

// Apply downloads the latest release binary, verifies its byte length and
// SHA-256 checksum against checksums.txt, atomically replaces the executable on
// disk, and optionally schedules an in-place reload.
func (u *Updater) Apply(ctx context.Context, opts ApplyOptions) (*ApplyResult, error) {
	u.applyMu.Lock()
	defer u.applyMu.Unlock()

	u.mu.Lock()
	if u.appliedResult != nil {
		cp := *u.appliedResult
		u.mu.Unlock()
		if opts.TriggerReload && u.opts.OnReload != nil {
			cp.Restarting = true
			u.triggerReloadOnce()
		}
		return &cp, nil
	}
	u.mu.Unlock()

	if !u.CanSelfUpdate() {
		return nil, errors.New("self-update is not supported for this binary build")
	}

	info, err := u.Check(ctx, CheckOptions{
		Force:      true,
		Prerelease: opts.Prerelease,
	})
	if err != nil {
		return nil, err
	}
	if !info.CanSelfUpdate {
		return nil, errors.New("self-update is not supported for this binary build")
	}

	resolvedExecPath := strings.TrimSpace(u.opts.ExecutablePath)
	if evaluated, evalErr := filepath.EvalSymlinks(resolvedExecPath); evalErr == nil && evaluated != "" {
		resolvedExecPath = evaluated
	}

	if !info.UpdateAvailable {
		return &ApplyResult{
			PreviousVersion: info.CurrentVersion,
			UpdatedVersion:  info.LatestVersion,
			BinaryPath:      resolvedExecPath,
			Restarting:      false,
		}, nil
	}

	if info.AssetSize <= 0 || info.AssetSize > maxReleaseAssetBytes {
		return nil, fmt.Errorf("invalid release asset size %d", info.AssetSize)
	}
	if err := ValidateUpdateURL(info.ChecksumsURL); err != nil {
		return nil, fmt.Errorf("invalid checksums URL: %w", err)
	}
	if err := ValidateUpdateURL(info.AssetURL); err != nil {
		return nil, fmt.Errorf("invalid asset URL: %w", err)
	}

	existingMode := os.FileMode(0o755)
	if st, statErr := os.Stat(resolvedExecPath); statErr == nil {
		existingMode = st.Mode().Perm()
	}

	// Create temporary file in the target binary's directory before downloading
	// so read-only directory errors fail fast and os.Rename stays on the same filesystem.
	execDir := filepath.Dir(resolvedExecPath)
	tmpFile, err := os.CreateTemp(execDir, ".jj-view-update-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temporary update file in %s: %w", execDir, err)
	}
	tmpPath := tmpFile.Name()
	tmpClosed := false
	defer func() {
		if !tmpClosed {
			_ = tmpFile.Close()
		}
		if tmpPath != "" {
			_ = os.Remove(tmpPath)
		}
	}()

	assetName := filepath.Base(strings.TrimSpace(u.opts.ReleaseAsset))
	expectedHex, err := u.fetchExpectedChecksum(ctx, info.ChecksumsURL, assetName)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, info.AssetURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create asset download request: %w", err)
	}
	req.Header.Set("User-Agent", "jj-view/"+cleanVersion(u.opts.CurrentVersion))

	resp, err := u.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to download release asset: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("asset download returned HTTP %d", resp.StatusCode)
	}

	hasher := sha256.New()
	limitedReader := io.LimitReader(resp.Body, maxReleaseAssetBytes+1)
	writtenBytes, err := io.Copy(io.MultiWriter(tmpFile, hasher), limitedReader)
	if err != nil {
		return nil, fmt.Errorf("failed while streaming release asset: %w", err)
	}
	if writtenBytes > maxReleaseAssetBytes {
		return nil, fmt.Errorf("downloaded asset exceeds maximum size of %d bytes", maxReleaseAssetBytes)
	}
	if writtenBytes != info.AssetSize {
		return nil, fmt.Errorf("downloaded asset size mismatch: got %d bytes, expected %d bytes", writtenBytes, info.AssetSize)
	}

	actualHex := strings.ToLower(hex.EncodeToString(hasher.Sum(nil)))
	if subtle.ConstantTimeCompare([]byte(actualHex), []byte(expectedHex)) != 1 {
		return nil, fmt.Errorf("SHA-256 checksum mismatch for %s: got %s, expected %s", assetName, actualHex, expectedHex)
	}

	if err := tmpFile.Sync(); err != nil {
		return nil, fmt.Errorf("failed to sync temporary binary: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return nil, fmt.Errorf("failed to close temporary binary: %w", err)
	}
	tmpClosed = true

	if err := os.Chmod(tmpPath, existingMode|0o755); err != nil {
		return nil, fmt.Errorf("failed to set executable permissions on updated binary: %w", err)
	}

	if err := replaceExecutable(tmpPath, resolvedExecPath); err != nil {
		return nil, err
	}
	tmpPath = ""

	restarting := opts.TriggerReload && u.opts.OnReload != nil
	result := &ApplyResult{
		PreviousVersion: info.CurrentVersion,
		UpdatedVersion:  info.LatestVersion,
		BinaryPath:      resolvedExecPath,
		Restarting:      restarting,
	}

	u.mu.Lock()
	u.appliedResult = result
	u.mu.Unlock()

	if restarting {
		u.triggerReloadOnce()
	}

	cp := *result
	return &cp, nil
}

func (u *Updater) triggerReloadOnce() {
	if u.opts.OnReload == nil {
		return
	}
	u.reloadOnce.Do(func() {
		go func() {
			time.Sleep(reloadDelay)
			_ = u.opts.OnReload()
		}()
	})
}

func (u *Updater) fetchExpectedChecksum(ctx context.Context, checksumsURL, assetName string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, checksumsURL, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create checksums request: %w", err)
	}
	req.Header.Set("User-Agent", "jj-view/"+cleanVersion(u.opts.CurrentVersion))

	resp, err := u.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to download checksums.txt: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("checksums.txt download returned HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxMetadataBytes+1))
	if err != nil {
		return "", fmt.Errorf("failed to read checksums.txt: %w", err)
	}
	if len(body) > maxMetadataBytes {
		return "", fmt.Errorf("checksums.txt exceeds maximum size of %d bytes", maxMetadataBytes)
	}

	return parseChecksumForAsset(string(body), assetName)
}

func parseChecksumForAsset(content, assetName string) (string, error) {
	sc := bufio.NewScanner(strings.NewReader(content))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		hashCandidate := strings.ToLower(fields[0])
		nameCandidate := strings.TrimPrefix(fields[1], "*")
		nameCandidate = filepath.Base(nameCandidate)
		if nameCandidate != assetName {
			continue
		}
		if len(hashCandidate) != 64 {
			return "", fmt.Errorf("invalid SHA-256 hash length for %s in checksums.txt", assetName)
		}
		if _, err := hex.DecodeString(hashCandidate); err != nil {
			return "", fmt.Errorf("invalid SHA-256 hex digest for %s in checksums.txt: %w", assetName, err)
		}
		return hashCandidate, nil
	}
	return "", fmt.Errorf("asset %q not found in checksums.txt", assetName)
}

func replaceExecutable(tmpPath, targetPath string) error {
	if runtime.GOOS == "windows" {
		oldPath := targetPath + ".old"
		_ = os.Remove(oldPath)
		if err := os.Rename(targetPath, oldPath); err != nil {
			return fmt.Errorf("failed to move running executable to %s: %w", oldPath, err)
		}
		if err := os.Rename(tmpPath, targetPath); err != nil {
			_ = os.Rename(oldPath, targetPath)
			return fmt.Errorf("failed to move updated binary into place: %w", err)
		}
		return nil
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		return fmt.Errorf("failed to replace executable %s: %w", targetPath, err)
	}
	return nil
}

// CleanupStaleFiles removes leftover .old backup binaries and orphaned
// .jj-view-update-* temporary files from previous self-update runs.
func CleanupStaleFiles(execPath string) {
	trimmed := strings.TrimSpace(execPath)
	if trimmed == "" {
		return
	}
	paths := []string{trimmed}
	if resolved, err := filepath.EvalSymlinks(trimmed); err == nil && resolved != "" && resolved != trimmed {
		paths = append(paths, resolved)
	}
	seenDirs := make(map[string]bool)
	for _, p := range paths {
		_ = os.Remove(p + ".old")
		dir := filepath.Dir(p)
		if seenDirs[dir] {
			continue
		}
		seenDirs[dir] = true
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasPrefix(entry.Name(), ".jj-view-update-") {
				_ = os.Remove(filepath.Join(dir, entry.Name()))
			}
		}
	}
}

type parsedSemver struct {
	major int
	minor int
	patch int
	pre   string
}

func parseSemver(v string) (parsedSemver, error) {
	s := strings.TrimSpace(v)
	s = strings.TrimPrefix(s, "v")
	s = strings.TrimPrefix(s, "V")
	if s == "" {
		return parsedSemver{}, errors.New("empty version string")
	}
	if plusIdx := strings.IndexByte(s, '+'); plusIdx != -1 {
		s = s[:plusIdx]
	}
	var pre string
	if dashIdx := strings.IndexByte(s, '-'); dashIdx != -1 {
		pre = s[dashIdx+1:]
		s = s[:dashIdx]
		if pre == "" {
			return parsedSemver{}, fmt.Errorf("empty prerelease identifier in %q", v)
		}
		for _, part := range strings.Split(pre, ".") {
			if part == "" {
				return parsedSemver{}, fmt.Errorf("invalid prerelease identifier in %q", v)
			}
		}
	}

	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return parsedSemver{}, fmt.Errorf("invalid semver %q: expected major.minor.patch", v)
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil || major < 0 {
		return parsedSemver{}, fmt.Errorf("invalid major version in %q", v)
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil || minor < 0 {
		return parsedSemver{}, fmt.Errorf("invalid minor version in %q", v)
	}
	patch, err := strconv.Atoi(parts[2])
	if err != nil || patch < 0 {
		return parsedSemver{}, fmt.Errorf("invalid patch version in %q", v)
	}

	return parsedSemver{
		major: major,
		minor: minor,
		patch: patch,
		pre:   pre,
	}, nil
}

// CompareSemver compares two semantic version strings according to SemVer 2.0.0.
// It returns -1 if v1 < v2, 0 if v1 == v2, and 1 if v1 > v2.
func CompareSemver(v1, v2 string) (int, error) {
	p1, err := parseSemver(v1)
	if err != nil {
		return 0, err
	}
	p2, err := parseSemver(v2)
	if err != nil {
		return 0, err
	}

	if p1.major != p2.major {
		if p1.major < p2.major {
			return -1, nil
		}
		return 1, nil
	}
	if p1.minor != p2.minor {
		if p1.minor < p2.minor {
			return -1, nil
		}
		return 1, nil
	}
	if p1.patch != p2.patch {
		if p1.patch < p2.patch {
			return -1, nil
		}
		return 1, nil
	}

	// Normal release has higher precedence than a prerelease.
	if p1.pre == "" && p2.pre == "" {
		return 0, nil
	}
	if p1.pre == "" {
		return 1, nil
	}
	if p2.pre == "" {
		return -1, nil
	}

	return comparePrerelease(p1.pre, p2.pre), nil
}

func comparePrerelease(pre1, pre2 string) int {
	parts1 := strings.Split(pre1, ".")
	parts2 := strings.Split(pre2, ".")
	minLen := len(parts1)
	if len(parts2) < minLen {
		minLen = len(parts2)
	}

	for i := 0; i < minLen; i++ {
		id1, id2 := parts1[i], parts2[i]
		if id1 == id2 {
			continue
		}
		num1, isNum1 := parseNumericIdentifier(id1)
		num2, isNum2 := parseNumericIdentifier(id2)
		if isNum1 && isNum2 {
			if num1 < num2 {
				return -1
			}
			return 1
		}
		if isNum1 != isNum2 {
			// Numeric identifiers always have lower precedence than non-numeric identifiers.
			if isNum1 {
				return -1
			}
			return 1
		}
		if id1 < id2 {
			return -1
		}
		return 1
	}

	if len(parts1) < len(parts2) {
		return -1
	}
	if len(parts1) > len(parts2) {
		return 1
	}
	return 0
}

func parseNumericIdentifier(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
	}
	val, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return val, true
}
