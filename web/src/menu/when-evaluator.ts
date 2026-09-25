/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ContextSource {
    get(key: string): unknown;
}

export type ContextRecord = Record<string, unknown>;

type TokenType =
    | 'LParen'
    | 'RParen'
    | 'And'
    | 'Or'
    | 'Not'
    | 'Eq'
    | 'NotEq'
    | 'RegexMatch'
    | 'Gt'
    | 'Lt'
    | 'GtEq'
    | 'LtEq'
    | 'In'
    | 'Regex'
    | 'String'
    | 'Number'
    | 'Boolean'
    | 'Identifier';

interface Token {
    readonly type: TokenType;
    readonly value: string;
    readonly regex?: RegExp;
}

interface ASTNode {
    evaluate(context: ContextSource): unknown;
}

class LiteralNode implements ASTNode {
    constructor(private readonly val: unknown) {}
    evaluate(): unknown {
        return this.val;
    }
}

class IdentifierNode implements ASTNode {
    constructor(private readonly name: string) {}
    evaluate(context: ContextSource): unknown {
        return context.get(this.name);
    }
    getName(): string {
        return this.name;
    }
}

class NotNode implements ASTNode {
    constructor(private readonly operand: ASTNode) {}
    evaluate(context: ContextSource): boolean {
        return !this.operand.evaluate(context);
    }
}

class BinaryOpNode implements ASTNode {
    constructor(
        private readonly left: ASTNode,
        private readonly op: '&&' | '||' | '==' | '!=' | '=~' | '>' | '<' | '>=' | '<=' | 'in',
        private readonly right: ASTNode,
    ) {}

    evaluate(context: ContextSource): unknown {
        if (this.op === '&&') {
            const leftVal = this.left.evaluate(context);
            if (!leftVal) {
                return false;
            }
            return Boolean(this.right.evaluate(context));
        }

        if (this.op === '||') {
            const leftVal = this.left.evaluate(context);
            if (leftVal) {
                return true;
            }
            return Boolean(this.right.evaluate(context));
        }

        const leftVal = this.left.evaluate(context);
        let rightVal = this.right.evaluate(context);

        // Fallback for string identifiers in VS Code when-clauses: e.g. "view == jj-view.logView"
        // If right is an identifier that resolved to undefined, treat its raw identifier name as a string literal.
        if (rightVal === undefined && this.right instanceof IdentifierNode) {
            rightVal = this.right.getName();
        }

        if (this.op === '==') {
            if (leftVal === undefined && rightVal === '') {
                return false;
            }
            if (leftVal === '' && rightVal === undefined) {
                return false;
            }
            return String(leftVal ?? '') === String(rightVal ?? '');
        }

        if (this.op === '!=') {
            if (leftVal === undefined && rightVal === '') {
                return true;
            }
            if (leftVal === '' && rightVal === undefined) {
                return true;
            }
            return String(leftVal ?? '') !== String(rightVal ?? '');
        }

        if (this.op === '=~') {
            const pattern = rightVal instanceof RegExp ? rightVal : new RegExp(String(rightVal ?? ''));
            return pattern.test(String(leftVal ?? ''));
        }

        if (this.op === '>') {
            return Number(leftVal ?? 0) > Number(rightVal ?? 0);
        }

        if (this.op === '>=') {
            return Number(leftVal ?? 0) >= Number(rightVal ?? 0);
        }

        if (this.op === '<') {
            return Number(leftVal ?? 0) < Number(rightVal ?? 0);
        }

        if (this.op === '<=') {
            return Number(leftVal ?? 0) <= Number(rightVal ?? 0);
        }

        if (this.op === 'in') {
            if (Array.isArray(rightVal)) {
                return rightVal.includes(leftVal);
            }
            if (typeof rightVal === 'string') {
                return rightVal.includes(String(leftVal ?? ''));
            }
            return false;
        }

        return false;
    }
}

function tokenize(expression: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const len = expression.length;

    while (i < len) {
        const char = expression[i];

        if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
            i++;
            continue;
        }

        if (char === '(') {
            tokens.push({ type: 'LParen', value: '(' });
            i++;
            continue;
        }

        if (char === ')') {
            tokens.push({ type: 'RParen', value: ')' });
            i++;
            continue;
        }

        if (char === '&' && expression[i + 1] === '&') {
            tokens.push({ type: 'And', value: '&&' });
            i += 2;
            continue;
        }

        if (char === '|' && expression[i + 1] === '|') {
            tokens.push({ type: 'Or', value: '||' });
            i += 2;
            continue;
        }

        if (char === '!' && expression[i + 1] === '=') {
            tokens.push({ type: 'NotEq', value: '!=' });
            i += 2;
            continue;
        }

        if (char === '!') {
            tokens.push({ type: 'Not', value: '!' });
            i++;
            continue;
        }

        if (char === '=' && expression[i + 1] === '=') {
            let offset = 2;
            if (expression[i + 2] === '=') {
                offset = 3;
            }
            tokens.push({ type: 'Eq', value: '==' });
            i += offset;
            continue;
        }

        if (char === '=' && expression[i + 1] === '~') {
            tokens.push({ type: 'RegexMatch', value: '=~' });
            i += 2;
            continue;
        }

        if (char === '>' && expression[i + 1] === '=') {
            tokens.push({ type: 'GtEq', value: '>=' });
            i += 2;
            continue;
        }

        if (char === '>') {
            tokens.push({ type: 'Gt', value: '>' });
            i++;
            continue;
        }

        if (char === '<' && expression[i + 1] === '=') {
            tokens.push({ type: 'LtEq', value: '<=' });
            i += 2;
            continue;
        }

        if (char === '<') {
            tokens.push({ type: 'Lt', value: '<' });
            i++;
            continue;
        }

        // String literal: '...' or "..."
        if (char === "'" || char === '"') {
            const quote = char;
            let str = '';
            i++;
            while (i < len && expression[i] !== quote) {
                if (expression[i] === '\\' && i + 1 < len) {
                    i++;
                    str += expression[i];
                } else {
                    str += expression[i];
                }
                i++;
            }
            if (i < len && expression[i] === quote) {
                i++; // Skip closing quote
            }
            tokens.push({ type: 'String', value: str });
            continue;
        }

        // Regex literal: /.../flags
        if (char === '/') {
            let pattern = '';
            i++;
            while (i < len && expression[i] !== '/') {
                if (expression[i] === '\\' && i + 1 < len) {
                    pattern += expression[i];
                    i++;
                    pattern += expression[i];
                } else {
                    pattern += expression[i];
                }
                i++;
            }
            if (i < len && expression[i] === '/') {
                i++; // Skip closing slash
            }
            let flags = '';
            while (i < len && /[a-z]/i.test(expression[i])) {
                flags += expression[i];
                i++;
            }
            try {
                const regex = new RegExp(pattern, flags);
                tokens.push({ type: 'Regex', value: `/${pattern}/${flags}`, regex });
            } catch {
                tokens.push({ type: 'String', value: pattern });
            }
            continue;
        }

        // Numbers
        if (/[0-9]/.test(char)) {
            let numStr = '';
            while (i < len && /[0-9.]/.test(expression[i])) {
                numStr += expression[i];
                i++;
            }
            tokens.push({ type: 'Number', value: numStr });
            continue;
        }

        // Identifiers (including dot notation, hyphens: config.jj-view.openDiffOnClick)
        if (/[a-zA-Z_$]/.test(char)) {
            let ident = '';
            while (i < len && /[a-zA-Z0-9_$.-]/.test(expression[i])) {
                ident += expression[i];
                i++;
            }
            if (ident === 'true') {
                tokens.push({ type: 'Boolean', value: 'true' });
                continue;
            }
            if (ident === 'false') {
                tokens.push({ type: 'Boolean', value: 'false' });
                continue;
            }
            if (ident === 'in') {
                tokens.push({ type: 'In', value: 'in' });
                continue;
            }
            tokens.push({ type: 'Identifier', value: ident });
            continue;
        }

        // Skip unrecognized character
        i++;
    }

    return tokens;
}

class Parser {
    private pos = 0;

    constructor(private readonly tokens: Token[]) {}

    private peek(): Token | undefined {
        return this.tokens[this.pos];
    }

    private next(): Token | undefined {
        const tok = this.tokens[this.pos];
        this.pos++;
        return tok;
    }

    private match(type: TokenType): boolean {
        const tok = this.peek();
        if (tok && tok.type === type) {
            this.pos++;
            return true;
        }
        return false;
    }

    public parse(): ASTNode | null {
        if (this.tokens.length === 0) {
            return null;
        }
        const ast = this.parseOr();
        if (this.pos < this.tokens.length) {
            return null;
        }
        return ast;
    }

    private parseOr(): ASTNode {
        let node = this.parseAnd();

        while (this.match('Or')) {
            const right = this.parseAnd();
            node = new BinaryOpNode(node, '||', right);
        }

        return node;
    }

    private parseAnd(): ASTNode {
        let node = this.parseUnary();

        while (this.match('And')) {
            const right = this.parseUnary();
            node = new BinaryOpNode(node, '&&', right);
        }

        return node;
    }

    private parseUnary(): ASTNode {
        if (this.match('Not')) {
            const operand = this.parseUnary();
            return new NotNode(operand);
        }

        return this.parseComparison();
    }

    private parseComparison(): ASTNode {
        const left = this.parsePrimary();

        const nextTok = this.peek();
        if (!nextTok) {
            return left;
        }

        if (this.match('Eq')) {
            const right = this.parsePrimary();
            return new BinaryOpNode(left, '==', right);
        }

        if (this.match('NotEq')) {
            const right = this.parsePrimary();
            return new BinaryOpNode(left, '!=', right);
        }

        if (this.match('RegexMatch')) {
            const right = this.parsePrimary();
            return new BinaryOpNode(left, '=~', right);
        }

        if (this.match('GtEq')) {
            const right = this.parsePrimary();
            return new BinaryOpNode(left, '>=', right);
        }

        if (this.match('Gt')) {
            const right = this.parsePrimary();
            return new BinaryOpNode(left, '>', right);
        }

        if (this.match('LtEq')) {
            const right = this.parsePrimary();
            return new BinaryOpNode(left, '<=', right);
        }

        if (this.match('Lt')) {
            const right = this.parsePrimary();
            return new BinaryOpNode(left, '<', right);
        }

        if (this.match('In')) {
            const right = this.parsePrimary();
            return new BinaryOpNode(left, 'in', right);
        }

        return left;
    }

    private parsePrimary(): ASTNode {
        const tok = this.next();
        if (!tok) {
            return new LiteralNode(false);
        }

        if (tok.type === 'LParen') {
            const inner = this.parseOr();
            this.match('RParen');
            return inner;
        }

        if (tok.type === 'Boolean') {
            return new LiteralNode(tok.value === 'true');
        }

        if (tok.type === 'String') {
            return new LiteralNode(tok.value);
        }

        if (tok.type === 'Number') {
            return new LiteralNode(Number(tok.value));
        }

        if (tok.type === 'Regex') {
            return new LiteralNode(tok.regex ?? new RegExp(tok.value));
        }

        if (tok.type === 'Identifier') {
            return new IdentifierNode(tok.value);
        }

        return new LiteralNode(false);
    }
}

export class RecordContextSource implements ContextSource {
    constructor(private readonly record: ContextRecord) {}

    get(key: string): unknown {
        if (key in this.record) {
            return this.record[key];
        }
        return undefined;
    }
}

const astCache = new Map<string, ASTNode | null>();

export function evaluateWhenClause(whenClause: string | undefined | null, context: ContextSource): boolean {
    if (!whenClause || whenClause.trim() === '') {
        return true;
    }

    const trimmed = whenClause.trim();
    if (trimmed === 'true') {
        return true;
    }
    if (trimmed === 'false') {
        return false;
    }

    let ast = astCache.get(trimmed);
    if (ast === undefined) {
        const tokens = tokenize(trimmed);
        const parser = new Parser(tokens);
        ast = parser.parse();
        astCache.set(trimmed, ast);
    }

    if (!ast) {
        return false;
    }

    return Boolean(ast.evaluate(context));
}

export function evaluateWhenClauseWithRecord(whenClause: string | undefined | null, record: ContextRecord): boolean {
    return evaluateWhenClause(whenClause, new RecordContextSource(record));
}

export function clearWhenClauseCache(): void {
    astCache.clear();
}

export const WhenEvaluator = {
    evaluate: evaluateWhenClause,
    evaluateWithRecord: evaluateWhenClauseWithRecord,
    clearCache: clearWhenClauseCache,
};
