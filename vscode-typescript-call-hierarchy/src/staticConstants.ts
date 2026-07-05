import * as path from 'path';
import * as ts from 'typescript';
import type { SymbolEntry } from './types';

/**
 * Collect statically known constant values from the program (exported const literals,
 * enum members). Used for CallCanvas Viewer symbolIndex tooltips (same idea as Java analyzer).
 */
export function collectStaticConstants(program: ts.Program, rootDir: string): Record<string, SymbolEntry> {
    const result: Record<string, SymbolEntry> = {};
    const checker = program.getTypeChecker();

    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('node_modules')) {
            continue;
        }
        const qualifier = path.relative(rootDir, sourceFile.fileName).split(path.sep).join('/');
        collectFromSourceFile(sourceFile, checker, qualifier, result);
    }

    return result;
}

function collectFromSourceFile(
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    qualifier: string,
    out: Record<string, SymbolEntry>
): void {
    function visit(node: ts.Node): void {
        if (ts.isEnumDeclaration(node)) {
            collectEnumMembers(node, sourceFile, checker, qualifier, out);
        } else if (ts.isVariableStatement(node)) {
            collectExportedConstLiterals(node, sourceFile, checker, qualifier, out);
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
}

function collectEnumMembers(
    node: ts.EnumDeclaration,
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    qualifier: string,
    out: Record<string, SymbolEntry>
): void {
    const enumName = node.name.text;
    for (const member of node.members) {
        const memberName = enumMemberName(member.name, sourceFile);
        if (memberName === null) {
            continue;
        }
        const constVal = checker.getConstantValue(member);
        if (constVal === undefined) {
            continue;
        }
        const valueStr = typeof constVal === 'string' ? JSON.stringify(constVal) : String(constVal);
        out[`${enumName}.${memberName}`] = { value: valueStr, qualifier, type: 'enum' };
    }
}

function collectExportedConstLiterals(
    node: ts.VariableStatement,
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    qualifier: string,
    out: Record<string, SymbolEntry>
): void {
    const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported || !(node.declarationList.flags & ts.NodeFlags.Const)) {
        return;
    }
    for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) {
            continue;
        }
        const init = decl.initializer;
        if (!isStaticLiteralInitializer(init)) {
            continue;
        }
        const name = decl.name.text;
        const valueStr = literalInitializerToString(init, sourceFile);
        const typeStr = checker.typeToString(checker.getTypeAtLocation(decl));
        out[name] = { value: valueStr, qualifier, type: typeStr };
    }
}

function enumMemberName(name: ts.PropertyName, sourceFile: ts.SourceFile): string | null {
    if (ts.isIdentifier(name)) {
        return name.text;
    }
    if (ts.isStringLiteral(name)) {
        return name.text;
    }
    return null;
}

function isStaticLiteralInitializer(init: ts.Expression): boolean {
    if (ts.isStringLiteral(init) || ts.isNumericLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        return true;
    }
    if (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword) {
        return true;
    }
    if (
        ts.isPrefixUnaryExpression(init) &&
        init.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(init.operand)
    ) {
        return true;
    }
    return false;
}

function literalInitializerToString(init: ts.Expression, sourceFile: ts.SourceFile): string {
    return init.getText(sourceFile);
}
