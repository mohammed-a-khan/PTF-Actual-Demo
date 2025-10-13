// src/utils/CSTextUtility.ts

import * as fs from 'fs';
import * as path from 'path';

/**
 * Comprehensive Text File Utility Class
 * Provides extensive text file operations, reading, writing, searching, and comparison
 */
export class CSTextUtility {

    // ===============================
    // READING OPERATIONS
    // ===============================

    /**
     * Read entire text file
     */
    static readFile(filePath: string, encoding: BufferEncoding = 'utf8'): string {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Text file not found: ${filePath}`);
        }
        return fs.readFileSync(filePath, encoding);
    }

    /**
     * Read text file asynchronously
     */
    static async readFileAsync(filePath: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Text file not found: ${filePath}`);
        }
        return await fs.promises.readFile(filePath, encoding);
    }

    /**
     * Read text file as array of lines
     */
    static readLines(filePath: string, encoding: BufferEncoding = 'utf8'): string[] {
        const content = this.readFile(filePath, encoding);
        return content.split(/\r?\n/);
    }

    /**
     * Read specific line by index (0-based)
     */
    static readLine(filePath: string, lineIndex: number, encoding: BufferEncoding = 'utf8'): string {
        const lines = this.readLines(filePath, encoding);
        if (lineIndex < 0 || lineIndex >= lines.length) {
            throw new Error(`Line index ${lineIndex} out of bounds (total lines: ${lines.length})`);
        }
        return lines[lineIndex];
    }

    /**
     * Read range of lines
     */
    static readLineRange(filePath: string, startLine: number, endLine: number, encoding: BufferEncoding = 'utf8'): string[] {
        const lines = this.readLines(filePath, encoding);
        return lines.slice(startLine, endLine + 1);
    }

    /**
     * Read first N lines
     */
    static readFirstLines(filePath: string, count: number, encoding: BufferEncoding = 'utf8'): string[] {
        const lines = this.readLines(filePath, encoding);
        return lines.slice(0, count);
    }

    /**
     * Read last N lines
     */
    static readLastLines(filePath: string, count: number, encoding: BufferEncoding = 'utf8'): string[] {
        const lines = this.readLines(filePath, encoding);
        return lines.slice(-count);
    }

    /**
     * Read file as Buffer
     */
    static readAsBuffer(filePath: string): Buffer {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        return fs.readFileSync(filePath);
    }

    /**
     * Read file as Base64
     */
    static readAsBase64(filePath: string): string {
        const buffer = this.readAsBuffer(filePath);
        return buffer.toString('base64');
    }

    /**
     * Check if file is empty
     */
    static isEmpty(filePath: string): boolean {
        const content = this.readFile(filePath).trim();
        return content.length === 0;
    }

    /**
     * Get line count
     */
    static getLineCount(filePath: string, encoding: BufferEncoding = 'utf8'): number {
        return this.readLines(filePath, encoding).length;
    }

    /**
     * Get word count
     */
    static getWordCount(filePath: string, encoding: BufferEncoding = 'utf8'): number {
        const content = this.readFile(filePath, encoding);
        const words = content.split(/\s+/).filter(word => word.length > 0);
        return words.length;
    }

    /**
     * Get character count
     */
    static getCharacterCount(filePath: string, encoding: BufferEncoding = 'utf8'): number {
        return this.readFile(filePath, encoding).length;
    }

    /**
     * Get character count (excluding whitespace)
     */
    static getCharacterCountNoSpaces(filePath: string, encoding: BufferEncoding = 'utf8'): number {
        const content = this.readFile(filePath, encoding);
        return content.replace(/\s/g, '').length;
    }

    // ===============================
    // WRITING OPERATIONS
    // ===============================

    /**
     * Write text to file (overwrites existing content)
     */
    static writeFile(filePath: string, content: string, encoding: BufferEncoding = 'utf8'): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, encoding);
    }

    /**
     * Write text to file asynchronously
     */
    static async writeFileAsync(filePath: string, content: string, encoding: BufferEncoding = 'utf8'): Promise<void> {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            await fs.promises.mkdir(dir, { recursive: true });
        }
        await fs.promises.writeFile(filePath, content, encoding);
    }

    /**
     * Write array of lines to file
     */
    static writeLines(filePath: string, lines: string[], encoding: BufferEncoding = 'utf8'): void {
        const content = lines.join('\n');
        this.writeFile(filePath, content, encoding);
    }

    /**
     * Append text to file
     */
    static appendText(filePath: string, content: string, encoding: BufferEncoding = 'utf8'): void {
        if (!fs.existsSync(filePath)) {
            this.writeFile(filePath, content, encoding);
        } else {
            fs.appendFileSync(filePath, content, encoding);
        }
    }

    /**
     * Append line to file
     */
    static appendLine(filePath: string, line: string, encoding: BufferEncoding = 'utf8'): void {
        const lineWithNewline = line + '\n';
        this.appendText(filePath, lineWithNewline, encoding);
    }

    /**
     * Append multiple lines to file
     */
    static appendLines(filePath: string, lines: string[], encoding: BufferEncoding = 'utf8'): void {
        const content = lines.join('\n') + '\n';
        this.appendText(filePath, content, encoding);
    }

    /**
     * Prepend text to file
     */
    static prependText(filePath: string, content: string, encoding: BufferEncoding = 'utf8'): void {
        const existingContent = fs.existsSync(filePath) ? this.readFile(filePath, encoding) : '';
        this.writeFile(filePath, content + existingContent, encoding);
    }

    /**
     * Prepend line to file
     */
    static prependLine(filePath: string, line: string, encoding: BufferEncoding = 'utf8'): void {
        const lineWithNewline = line + '\n';
        this.prependText(filePath, lineWithNewline, encoding);
    }

    /**
     * Insert text at specific position
     */
    static insertTextAtPosition(filePath: string, position: number, text: string, encoding: BufferEncoding = 'utf8'): void {
        const content = this.readFile(filePath, encoding);
        const newContent = content.slice(0, position) + text + content.slice(position);
        this.writeFile(filePath, newContent, encoding);
    }

    /**
     * Insert line at specific line index
     */
    static insertLineAt(filePath: string, lineIndex: number, line: string, encoding: BufferEncoding = 'utf8'): void {
        const lines = this.readLines(filePath, encoding);
        lines.splice(lineIndex, 0, line);
        this.writeLines(filePath, lines, encoding);
    }

    /**
     * Replace specific line
     */
    static replaceLine(filePath: string, lineIndex: number, newLine: string, encoding: BufferEncoding = 'utf8'): void {
        const lines = this.readLines(filePath, encoding);
        if (lineIndex < 0 || lineIndex >= lines.length) {
            throw new Error(`Line index ${lineIndex} out of bounds`);
        }
        lines[lineIndex] = newLine;
        this.writeLines(filePath, lines, encoding);
    }

    /**
     * Delete specific line
     */
    static deleteLine(filePath: string, lineIndex: number, encoding: BufferEncoding = 'utf8'): void {
        const lines = this.readLines(filePath, encoding);
        if (lineIndex < 0 || lineIndex >= lines.length) {
            throw new Error(`Line index ${lineIndex} out of bounds`);
        }
        lines.splice(lineIndex, 1);
        this.writeLines(filePath, lines, encoding);
    }

    /**
     * Delete multiple lines
     */
    static deleteLines(filePath: string, startLine: number, endLine: number, encoding: BufferEncoding = 'utf8'): void {
        const lines = this.readLines(filePath, encoding);
        lines.splice(startLine, endLine - startLine + 1);
        this.writeLines(filePath, lines, encoding);
    }

    /**
     * Clear file content
     */
    static clearFile(filePath: string): void {
        this.writeFile(filePath, '');
    }

    // ===============================
    // SEARCH AND FILTER OPERATIONS
    // ===============================

    /**
     * Search for text in file
     */
    static searchText(filePath: string, searchText: string, caseSensitive: boolean = true, encoding: BufferEncoding = 'utf8'): {
        found: boolean;
        count: number;
        positions: number[];
    } {
        const content = this.readFile(filePath, encoding);
        const searchContent = caseSensitive ? content : content.toLowerCase();
        const search = caseSensitive ? searchText : searchText.toLowerCase();

        const positions: number[] = [];
        let index = 0;

        while ((index = searchContent.indexOf(search, index)) !== -1) {
            positions.push(index);
            index += search.length;
        }

        return {
            found: positions.length > 0,
            count: positions.length,
            positions
        };
    }

    /**
     * Search for pattern using regex
     */
    static searchPattern(filePath: string, pattern: RegExp, encoding: BufferEncoding = 'utf8'): {
        found: boolean;
        matches: Array<{ match: string; index: number }>;
    } {
        const content = this.readFile(filePath, encoding);
        const matches: Array<{ match: string; index: number }> = [];

        let match;
        while ((match = pattern.exec(content)) !== null) {
            matches.push({ match: match[0], index: match.index });
        }

        return {
            found: matches.length > 0,
            matches
        };
    }

    /**
     * Find lines containing text
     */
    static findLinesContaining(filePath: string, searchText: string, caseSensitive: boolean = true, encoding: BufferEncoding = 'utf8'): Array<{ lineNumber: number; content: string }> {
        const lines = this.readLines(filePath, encoding);
        const results: Array<{ lineNumber: number; content: string }> = [];

        lines.forEach((line, index) => {
            const searchLine = caseSensitive ? line : line.toLowerCase();
            const search = caseSensitive ? searchText : searchText.toLowerCase();

            if (searchLine.includes(search)) {
                results.push({ lineNumber: index + 1, content: line });
            }
        });

        return results;
    }

    /**
     * Find lines matching pattern
     */
    static findLinesMatching(filePath: string, pattern: RegExp, encoding: BufferEncoding = 'utf8'): Array<{ lineNumber: number; content: string }> {
        const lines = this.readLines(filePath, encoding);
        const results: Array<{ lineNumber: number; content: string }> = [];

        lines.forEach((line, index) => {
            if (pattern.test(line)) {
                results.push({ lineNumber: index + 1, content: line });
            }
        });

        return results;
    }

    /**
     * Filter lines by predicate
     */
    static filterLines(filePath: string, predicate: (line: string, index: number) => boolean, encoding: BufferEncoding = 'utf8'): string[] {
        const lines = this.readLines(filePath, encoding);
        return lines.filter(predicate);
    }

    /**
     * Remove empty lines
     */
    static removeEmptyLines(filePath: string, outputPath?: string, encoding: BufferEncoding = 'utf8'): void {
        const lines = this.readLines(filePath, encoding);
        const nonEmptyLines = lines.filter(line => line.trim().length > 0);
        this.writeLines(outputPath || filePath, nonEmptyLines, encoding);
    }

    /**
     * Remove duplicate lines
     */
    static removeDuplicateLines(filePath: string, outputPath?: string, encoding: BufferEncoding = 'utf8'): void {
        const lines = this.readLines(filePath, encoding);
        const uniqueLines = [...new Set(lines)];
        this.writeLines(outputPath || filePath, uniqueLines, encoding);
    }

    // ===============================
    // TRANSFORMATION OPERATIONS
    // ===============================

    /**
     * Replace all occurrences of text
     */
    static replaceAll(filePath: string, searchText: string, replaceText: string, encoding: BufferEncoding = 'utf8'): void {
        const content = this.readFile(filePath, encoding);
        const newContent = content.split(searchText).join(replaceText);
        this.writeFile(filePath, newContent, encoding);
    }

    /**
     * Replace using regex
     */
    static replacePattern(filePath: string, pattern: RegExp, replacement: string, encoding: BufferEncoding = 'utf8'): void {
        const content = this.readFile(filePath, encoding);
        const newContent = content.replace(pattern, replacement);
        this.writeFile(filePath, newContent, encoding);
    }

    /**
     * Convert to uppercase
     */
    static toUpperCase(filePath: string, outputPath?: string, encoding: BufferEncoding = 'utf8'): void {
        const content = this.readFile(filePath, encoding);
        this.writeFile(outputPath || filePath, content.toUpperCase(), encoding);
    }

    /**
     * Convert to lowercase
     */
    static toLowerCase(filePath: string, outputPath?: string, encoding: BufferEncoding = 'utf8'): void {
        const content = this.readFile(filePath, encoding);
        this.writeFile(outputPath || filePath, content.toLowerCase(), encoding);
    }

    /**
     * Trim whitespace from all lines
     */
    static trimLines(filePath: string, outputPath?: string, encoding: BufferEncoding = 'utf8'): void {
        const lines = this.readLines(filePath, encoding);
        const trimmedLines = lines.map(line => line.trim());
        this.writeLines(outputPath || filePath, trimmedLines, encoding);
    }

    /**
     * Reverse file content
     */
    static reverse(filePath: string, outputPath?: string, encoding: BufferEncoding = 'utf8'): void {
        const content = this.readFile(filePath, encoding);
        const reversed = content.split('').reverse().join('');
        this.writeFile(outputPath || filePath, reversed, encoding);
    }

    /**
     * Reverse line order
     */
    static reverseLines(filePath: string, outputPath?: string, encoding: BufferEncoding = 'utf8'): void {
        const lines = this.readLines(filePath, encoding);
        const reversedLines = lines.reverse();
        this.writeLines(outputPath || filePath, reversedLines, encoding);
    }

    /**
     * Sort lines alphabetically
     */
    static sortLines(filePath: string, ascending: boolean = true, outputPath?: string, encoding: BufferEncoding = 'utf8'): void {
        const lines = this.readLines(filePath, encoding);
        const sortedLines = ascending ? lines.sort() : lines.sort().reverse();
        this.writeLines(outputPath || filePath, sortedLines, encoding);
    }

    /**
     * Merge multiple text files
     */
    static mergeFiles(filePaths: string[], outputPath: string, separator: string = '\n', encoding: BufferEncoding = 'utf8'): void {
        const contents = filePaths.map(filePath => this.readFile(filePath, encoding));
        const merged = contents.join(separator);
        this.writeFile(outputPath, merged, encoding);
    }

    /**
     * Split file into chunks by line count
     */
    static splitByLines(filePath: string, linesPerFile: number, outputDir: string, encoding: BufferEncoding = 'utf8'): void {
        const lines = this.readLines(filePath, encoding);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        let fileIndex = 1;
        for (let i = 0; i < lines.length; i += linesPerFile) {
            const chunk = lines.slice(i, i + linesPerFile);
            const outputPath = path.join(outputDir, `part_${fileIndex}.txt`);
            this.writeLines(outputPath, chunk, encoding);
            fileIndex++;
        }
    }

    /**
     * Split file by delimiter
     */
    static splitByDelimiter(filePath: string, delimiter: string, outputDir: string, encoding: BufferEncoding = 'utf8'): void {
        const content = this.readFile(filePath, encoding);
        const parts = content.split(delimiter);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        parts.forEach((part, index) => {
            const outputPath = path.join(outputDir, `part_${index + 1}.txt`);
            this.writeFile(outputPath, part, encoding);
        });
    }

    // ===============================
    // COMPARISON OPERATIONS
    // ===============================

    /**
     * Compare two text files
     */
    static compareFiles(file1: string, file2: string, encoding: BufferEncoding = 'utf8'): {
        areEqual: boolean;
        differences: Array<{ lineNumber: number; line1: string; line2: string }>;
    } {
        const lines1 = this.readLines(file1, encoding);
        const lines2 = this.readLines(file2, encoding);

        const differences: Array<{ lineNumber: number; line1: string; line2: string }> = [];
        const maxLines = Math.max(lines1.length, lines2.length);

        for (let i = 0; i < maxLines; i++) {
            const line1 = lines1[i] || '';
            const line2 = lines2[i] || '';

            if (line1 !== line2) {
                differences.push({ lineNumber: i + 1, line1, line2 });
            }
        }

        return {
            areEqual: differences.length === 0,
            differences
        };
    }

    /**
     * Check if two files are identical
     */
    static areFilesIdentical(file1: string, file2: string, encoding: BufferEncoding = 'utf8'): boolean {
        const content1 = this.readFile(file1, encoding);
        const content2 = this.readFile(file2, encoding);
        return content1 === content2;
    }

    /**
     * Calculate similarity percentage
     */
    static calculateSimilarity(file1: string, file2: string, encoding: BufferEncoding = 'utf8'): number {
        const content1 = this.readFile(file1, encoding);
        const content2 = this.readFile(file2, encoding);

        if (content1 === content2) return 100;

        const longer = content1.length > content2.length ? content1 : content2;
        const shorter = content1.length > content2.length ? content2 : content1;

        if (longer.length === 0) return 100;

        const editDistance = this.levenshteinDistance(longer, shorter);
        return ((longer.length - editDistance) / longer.length) * 100;
    }

    // ===============================
    // UTILITY OPERATIONS
    // ===============================

    /**
     * Get file metadata
     */
    static getFileMetadata(filePath: string, encoding: BufferEncoding = 'utf8'): {
        exists: boolean;
        size: number;
        sizeInKB: number;
        sizeInMB: number;
        lineCount: number;
        wordCount: number;
        characterCount: number;
        extension: string;
        filename: string;
        created: Date;
        modified: Date;
    } {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const stats = fs.statSync(filePath);

        return {
            exists: true,
            size: stats.size,
            sizeInKB: stats.size / 1024,
            sizeInMB: stats.size / (1024 * 1024),
            lineCount: this.getLineCount(filePath, encoding),
            wordCount: this.getWordCount(filePath, encoding),
            characterCount: this.getCharacterCount(filePath, encoding),
            extension: path.extname(filePath),
            filename: path.basename(filePath),
            created: stats.birthtime,
            modified: stats.mtime
        };
    }

    /**
     * Clone file
     */
    static cloneFile(sourcePath: string, targetPath: string): void {
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.copyFileSync(sourcePath, targetPath);
    }

    /**
     * Extract words from file
     */
    static extractWords(filePath: string, encoding: BufferEncoding = 'utf8'): string[] {
        const content = this.readFile(filePath, encoding);
        return content.split(/\s+/).filter(word => word.length > 0);
    }

    /**
     * Get unique words
     */
    static getUniqueWords(filePath: string, encoding: BufferEncoding = 'utf8'): string[] {
        const words = this.extractWords(filePath, encoding);
        return [...new Set(words)];
    }

    /**
     * Get word frequency
     */
    static getWordFrequency(filePath: string, encoding: BufferEncoding = 'utf8'): Map<string, number> {
        const words = this.extractWords(filePath, encoding);
        const frequency = new Map<string, number>();

        words.forEach(word => {
            frequency.set(word, (frequency.get(word) || 0) + 1);
        });

        return frequency;
    }

    /**
     * Check if file exists
     */
    static fileExists(filePath: string): boolean {
        return fs.existsSync(filePath);
    }

    /**
     * Delete file
     */
    static deleteFile(filePath: string): void {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    /**
     * Rename/Move file
     */
    static renameFile(oldPath: string, newPath: string): void {
        fs.renameSync(oldPath, newPath);
    }

    // ===============================
    // PRIVATE HELPER METHODS
    // ===============================

    private static levenshteinDistance(str1: string, str2: string): number {
        const matrix: number[][] = [];

        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[str2.length][str1.length];
    }
}
