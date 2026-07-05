import { CallHierarchyData, MethodNode } from './analyzer';

/**
 * Render the call hierarchy data as a markdown document.
 * @param data Call hierarchy data from analyzer
 * @param methodSignature Root method signature
 * @param maxDepth Maximum depth to display (1 = root only, 2 = root + children, etc.)
 */
export function renderAsMarkdown(
    data: CallHierarchyData,
    methodSignature: string,
    maxDepth: number = 3
): string {
    const lines: string[] = [];

    // Header
    lines.push('# Call Hierarchy Analysis');
    lines.push('');
    lines.push(`**Root Method:** \`${methodSignature}\`  `);
    lines.push(`**Generated:** ${new Date().toLocaleString()}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Tree view
    lines.push('## Call Tree');
    lines.push('');
    lines.push('```');
    renderTree(data.root, lines, '', true, new Set(), 1, maxDepth);
    lines.push('```');
    lines.push('');

    // Statistics (also respects maxDepth)
    const stats = calculateStats(data.root, maxDepth);
    lines.push('## Statistics');
    lines.push('');
    lines.push(`- **Total Methods:** ${stats.totalMethods}`);
    lines.push(`- **Max Depth:** ${stats.maxDepth}`);
    lines.push(`- **Unique Methods:** ${stats.uniqueMethods}`);
    lines.push('');

    // Method list (also respects maxDepth)
    lines.push('## Method Details');
    lines.push('');
    renderMethodList(data.root, lines, new Set(), 1, maxDepth);

    return lines.join('\n');
}

/**
 * Render the tree structure with box-drawing characters.
 * Uses visited set to prevent infinite recursion on circular references.
 * @param currentDepth Current depth in the tree (1 = root)
 * @param maxDepth Maximum depth to render
 */
function renderTree(
    node: MethodNode,
    lines: string[],
    prefix: string,
    isLast: boolean,
    visited: Set<string>,
    currentDepth: number,
    maxDepth: number
): void {
    // Current node
    const connector = isLast ? '└─ ' : '├─ ';
    const displayName = node.shortName || extractShortName(node.method);
    
    // Check for recursive call
    const isRecursive = visited.has(node.method);
    
    if (prefix === '') {
        // Root node
        lines.push(displayName);
    } else {
        lines.push(prefix + connector + displayName + (isRecursive ? ' (recursive)' : ''));
    }

    // Stop recursion if already visited in this path
    if (isRecursive) {
        return;
    }

    // Stop if we've reached max depth
    if (currentDepth >= maxDepth) {
        return;
    }
    
    // Mark as visited for this branch
    visited.add(node.method);

    // Children
    const childPrefix = prefix + (isLast ? '   ' : '│  ');
    const children = node.calls || [];
    
    for (let i = 0; i < children.length; i++) {
        const isChildLast = i === children.length - 1;
        renderTree(children[i], lines, childPrefix, isChildLast, new Set(visited), currentDepth + 1, maxDepth);
    }
}

/**
 * Extract a short display name from a full method signature.
 */
function extractShortName(fullMethod: string): string {
    // Handle format: package.ClassName#methodName(params)
    const hashMatch = fullMethod.match(/(?:[\w.]+\.)?(\w+)#(\w+)(?:\([^)]*\))?/);
    if (hashMatch) {
        return `${hashMatch[1]}.${hashMatch[2]}()`;
    }

    // Handle format: package.ClassName.methodName()
    const dotMatch = fullMethod.match(/(?:[\w.]+\.)?(\w+)\.(\w+)\(\)/);
    if (dotMatch) {
        return `${dotMatch[1]}.${dotMatch[2]}()`;
    }

    // Handle simple format: ClassName.methodName()
    if (fullMethod.includes('.') && fullMethod.includes('(')) {
        const parts = fullMethod.split('.');
        const lastPart = parts[parts.length - 1];
        const secondLastPart = parts[parts.length - 2];
        if (secondLastPart) {
            return `${secondLastPart}.${lastPart}`;
        }
    }

    return fullMethod;
}

interface TreeStats {
    totalMethods: number;
    maxDepth: number;
    uniqueMethods: number;
}

/**
 * Calculate statistics about the call tree.
 * Uses path tracking to prevent infinite recursion on circular references.
 * @param maxDisplayDepth Maximum depth to consider for statistics
 */
function calculateStats(root: MethodNode, maxDisplayDepth: number): TreeStats {
    const methodSet = new Set<string>();
    let totalCount = 0;
    let maxDepth = 0;

    function traverse(node: MethodNode, depth: number, path: Set<string>): void {
        // Check for circular reference in current path
        if (path.has(node.method)) {
            return;
        }

        // Stop if we've exceeded max display depth
        if (depth > maxDisplayDepth) {
            return;
        }
        
        totalCount++;
        methodSet.add(node.method);
        maxDepth = Math.max(maxDepth, depth);

        // Add to current path
        const newPath = new Set(path);
        newPath.add(node.method);

        for (const child of node.calls || []) {
            traverse(child, depth + 1, newPath);
        }
    }

    traverse(root, 1, new Set());

    return {
        totalMethods: totalCount,
        maxDepth: maxDepth,
        uniqueMethods: methodSet.size
    };
}

/**
 * Render a list of all methods with their details.
 * @param currentDepth Current depth (1 = root)
 * @param maxDepth Maximum depth to include in method list
 */
function renderMethodList(
    node: MethodNode,
    lines: string[],
    visited: Set<string>,
    currentDepth: number,
    maxDepth: number
): void {
    if (visited.has(node.method)) {
        return;
    }

    // Stop if we've exceeded max depth
    if (currentDepth > maxDepth) {
        return;
    }

    visited.add(node.method);

    const shortName = node.shortName || extractShortName(node.method);
    
    // Only count children that would be displayed (within depth limit)
    const displayableChildren = currentDepth < maxDepth ? (node.calls || []) : [];
    const callCount = displayableChildren.length;

    lines.push(`### ${shortName}`);
    lines.push('');
    lines.push(`- **Full Name:** \`${node.method}\``);
    
    if (node.file) {
        lines.push(`- **File:** ${node.file}`);
    }
    if (node.line) {
        lines.push(`- **Line:** ${node.line}`);
    }
    
    lines.push(`- **Calls:** ${callCount} method(s)`);
    
    if (callCount > 0) {
        lines.push('- **Called Methods:**');
        for (const child of displayableChildren) {
            const childName = child.shortName || extractShortName(child.method);
            lines.push(`  - \`${childName}\``);
        }
    }
    
    lines.push('');

    // Recurse to children (only if within depth limit)
    for (const child of displayableChildren) {
        renderMethodList(child, lines, visited, currentDepth + 1, maxDepth);
    }
}

