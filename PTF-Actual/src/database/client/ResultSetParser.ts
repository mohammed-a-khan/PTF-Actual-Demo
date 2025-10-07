// src/database/client/ResultSetParser.ts

import { ResultSet, QueryResult, QueryOptions, ResultMetadata } from '../types/database.types';
import { CSDatabaseAdapter } from '../adapters/DatabaseAdapter';
import { CSReporter } from '../../reporter/CSReporter';
import * as fs from 'fs/promises';
import * as XLSX from 'xlsx';

export class ResultSetParser {
  constructor(_adapter: CSDatabaseAdapter) {
  }

  parse<T = any>(rawResult: QueryResult, options?: QueryOptions): ResultSet {
    try {
      const rows = this.extractRows<T>(rawResult);
      const columns = this.extractColumns(rawResult);
      const metadata = this.extractMetadata(rawResult);
      const rowCount = this.extractRowCount(rawResult, rows);

      const transformedRows = options?.transform 
        ? this.applyTransformations(rows, options.transform)
        : rows;

      const paginatedRows = options?.pagination
        ? this.applyPagination(transformedRows, options.pagination)
        : transformedRows;

      const result: ResultSet = {
        rows: paginatedRows,
        fields: rawResult.fields || [],
        rowCount,
        metadata
      };
      
      if (columns) {
        result.columns = columns;
      }
      if (rawResult['executionTime'] !== undefined) {
        result.executionTime = rawResult['executionTime'];
      }
      if (rawResult.affectedRows !== undefined) {
        result.affectedRows = rawResult.affectedRows;
      }
      
      return result;
    } catch (error) {
      CSReporter.error('Failed to parse result set: ' + (error as Error).message);
      throw new Error(`Result parsing failed: ${(error as Error).message}`);
    }
  }

  async export(resultSet: ResultSet, format: 'csv' | 'json' | 'xml' | 'excel' | 'text', filePath: string): Promise<void> {
    try {
      CSReporter.info(`Exporting ${resultSet.rowCount} rows to ${format} format`);

      switch (format) {
        case 'csv':
          await this.exportToCSV(resultSet, filePath);
          break;
        case 'json':
          await this.exportToJSON(resultSet, filePath);
          break;
        case 'xml':
          await this.exportToXML(resultSet, filePath);
          break;
        case 'excel':
          await this.exportToExcel(resultSet, filePath);
          break;
        case 'text':
          await this.exportToText(resultSet, filePath);
          break;
        default:
          throw new Error(`Unsupported export format: ${format}`);
      }

      CSReporter.info(`Export completed: ${filePath}`);
    } catch (error) {
      CSReporter.error('Export failed: ' + (error as Error).message);
      throw new Error(`Failed to export result set: ${(error as Error).message}`);
    }
  }

  async import(filePath: string, format: 'csv' | 'json' | 'xml' | 'excel', options?: any): Promise<any[]> {
    try {
      CSReporter.info(`Importing data from ${format} file: ${filePath}`);

      let data: any[];

      switch (format) {
        case 'csv':
          data = await this.importFromCSV(filePath, options);
          break;
        case 'json':
          data = await this.importFromJSON(filePath);
          break;
        case 'xml':
          data = await this.importFromXML(filePath, options);
          break;
        case 'excel':
          data = await this.importFromExcel(filePath, options);
          break;
        default:
          throw new Error(`Unsupported import format: ${format}`);
      }

      CSReporter.info(`Imported ${data.length} records`);
      return data;
    } catch (error) {
      CSReporter.error('Import failed: ' + (error as Error).message);
      throw new Error(`Failed to import data: ${(error as Error).message}`);
    }
  }

  toObjects<T = any>(resultSet: ResultSet): T[] {
    return resultSet.rows as T[];
  }

  toArray(resultSet: ResultSet, includeHeaders: boolean = true): any[][] {
    const result: any[][] = [];
    const columns = resultSet.columns || [];

    if (includeHeaders && columns.length > 0) {
      result.push(columns.map((col: any) => col.name));
    }

    if (columns.length > 0) {
      resultSet.rows.forEach(row => {
        const values = columns.map((col: any) => row[col.name]);
        result.push(values);
      });
    }

    return result;
  }

  toMap<K, V>(resultSet: ResultSet, keyColumn: string, valueColumn?: string): Map<K, V> {
    const map = new Map<K, V>();

    resultSet.rows.forEach(row => {
      const key = row[keyColumn] as K;
      const value = valueColumn ? row[valueColumn] as V : row as V;
      map.set(key, value);
    });

    return map;
  }

  groupBy<T = any>(resultSet: ResultSet, column: string): Map<any, T[]> {
    const groups = new Map<any, T[]>();

    resultSet.rows.forEach((row: any) => {
      const key = row[column];
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(row);
    });

    return groups;
  }

  private extractRows<T>(rawResult: QueryResult): T[] {
    if (Array.isArray(rawResult)) {
      return rawResult as T[];
    } else if (rawResult.rows !== undefined) {
      return rawResult.rows as T[];
    } else if (rawResult['recordset'] !== undefined) {
      return rawResult['recordset'] as T[];
    } else if (rawResult['data'] !== undefined) {
      return rawResult['data'] as T[];
    } else if (typeof rawResult === 'object' && rawResult !== null) {
      return [rawResult as T];
    }

    return [];
  }

  private extractColumns(rawResult: QueryResult): ResultMetadata[] {
    const columns: ResultMetadata[] = [];

    if (rawResult.fields) {
      rawResult.fields.forEach((field: any) => {
        columns.push({
          name: field.name,
          type: this.mapDataType(field.dataTypeID || field.type),
          nullable: field.allowNull !== false,
          length: field.length || field.characterMaximumLength,
          precision: field.precision,
          scale: field.scale
        });
      });
    } else if (rawResult['columns']) {
      (rawResult['columns'] as any[]).forEach((col: any) => {
        columns.push({
          name: col.name || col.column_name,
          type: this.mapDataType(col.type || col.data_type),
          nullable: col.nullable !== false,
          length: col.length || col.max_length,
          precision: col.precision,
          scale: col.scale
        });
      });
    } else if (rawResult['recordset'] && rawResult['recordset']['columns']) {
      Object.entries(rawResult['recordset']['columns'] as Record<string, any>).forEach(([name, col]: [string, any]) => {
        columns.push({
          name,
          type: this.mapDataType(col.type),
          nullable: col.nullable,
          length: col.length,
          precision: col.precision,
          scale: col.scale
        });
      });
    } else if (rawResult.rows && rawResult.rows.length > 0) {
      const firstRow = rawResult.rows[0];
      Object.keys(firstRow).forEach(key => {
        columns.push({
          name: key,
          type: this.inferDataType(firstRow[key]),
          nullable: true
        });
      });
    }

    return columns;
  }

  private extractMetadata(rawResult: QueryResult): Record<string, any> {
    const metadata: Record<string, any> = {};

    if (rawResult['command']) metadata['command'] = rawResult['command'];
    if (rawResult['rowCount'] !== undefined) metadata['rowCount'] = rawResult['rowCount'];
    if (rawResult['duration'] !== undefined) metadata['duration'] = rawResult['duration'];
    if (rawResult['message']) metadata['message'] = rawResult['message'];

    return metadata;
  }

  private extractRowCount(rawResult: QueryResult, rows: any[]): number {
    if (rawResult.rowCount !== undefined) {
      return rawResult.rowCount;
    } else if (rawResult.affectedRows !== undefined) {
      return rawResult.affectedRows;
    } else {
      return rows.length;
    }
  }

  private mapDataType(dbType: any): string {
    const typeStr = String(dbType).toLowerCase();

    if (typeStr.includes('int')) return 'integer';
    if (typeStr.includes('num') || typeStr.includes('dec') || typeStr.includes('float') || typeStr.includes('double')) return 'number';
    if (typeStr.includes('char') || typeStr.includes('text') || typeStr.includes('string')) return 'string';
    if (typeStr.includes('bool')) return 'boolean';
    if (typeStr.includes('date') || typeStr.includes('time')) return 'datetime';
    if (typeStr.includes('json')) return 'json';
    if (typeStr.includes('xml')) return 'xml';
    if (typeStr.includes('bin') || typeStr.includes('blob')) return 'binary';

    return typeStr;
  }

  private inferDataType(value: any): string {
    if (value === null || value === undefined) return 'unknown';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (value instanceof Date) return 'datetime';
    if (typeof value === 'object') return 'json';
    return 'string';
  }

  private applyTransformations(rows: any[], transform: Record<string, (value: any) => any>): any[] {
    return rows.map(row => {
      const transformed = { ...row };
      
      Object.entries(transform).forEach(([column, transformer]) => {
        if (column in transformed) {
          transformed[column] = transformer(transformed[column]);
        }
      });

      return transformed;
    });
  }

  private applyPagination(rows: any[], pagination: { page: number; pageSize: number }): any[] {
    const { page, pageSize } = pagination;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    return rows.slice(start, end);
  }

  private async exportToCSV(resultSet: ResultSet, filePath: string): Promise<void> {
    const csv: string[] = [];

    const columns = resultSet.columns || [];
    if (columns.length > 0) {
      csv.push(columns.map((col: ResultMetadata) => this.escapeCSV(col.name)).join(','));
    }

    resultSet.rows.forEach(row => {
      const values = columns.map((col: ResultMetadata) => {
        const value = row[col.name];
        return this.escapeCSV(this.formatValue(value));
      });
      csv.push(values.join(','));
    });

    await fs.writeFile(filePath, csv.join('\n'), 'utf8');
  }

  private async exportToJSON(resultSet: ResultSet, filePath: string): Promise<void> {
    const data = {
      metadata: {
        columns: resultSet.columns || [],
        rowCount: resultSet.rowCount,
        executionTime: resultSet.executionTime || 0,
        exportedAt: new Date().toISOString()
      },
      data: resultSet.rows
    };

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private async exportToXML(resultSet: ResultSet, filePath: string): Promise<void> {
    const xml: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
    xml.push('<resultset>');
    xml.push('  <metadata>');
    xml.push(`    <rowCount>${resultSet.rowCount}</rowCount>`);
    xml.push(`    <executionTime>${resultSet.executionTime || 0}</executionTime>`);
    xml.push('    <columns>');
    
    const columns = resultSet.columns || [];
    columns.forEach((col: ResultMetadata) => {
      xml.push('      <column>');
      xml.push(`        <name>${this.escapeXML(col.name)}</name>`);
      xml.push(`        <type>${col.type}</type>`);
      xml.push('      </column>');
    });
    
    xml.push('    </columns>');
    xml.push('  </metadata>');
    xml.push('  <data>');

    resultSet.rows.forEach(row => {
      xml.push('    <row>');
      columns.forEach((col: ResultMetadata) => {
        const value = row[col.name];
        xml.push(`      <${col.name}>${this.escapeXML(this.formatValue(value))}</${col.name}>`);
      });
      xml.push('    </row>');
    });

    xml.push('  </data>');
    xml.push('</resultset>');

    await fs.writeFile(filePath, xml.join('\n'), 'utf8');
  }

  private async exportToExcel(resultSet: ResultSet, filePath: string): Promise<void> {
    const workbook = XLSX.utils.book_new();
    
    const data = this.toArray(resultSet, true);
    
    const worksheet = XLSX.utils.aoa_to_sheet(data);
    
    const columnWidths: any[] = [];
    const columns = resultSet.columns || [];
    columns.forEach((col: ResultMetadata, index: number) => {
      let maxWidth = col.name.length;
      
      resultSet.rows.forEach(row => {
        const value = String(row[col.name] || '');
        maxWidth = Math.max(maxWidth, value.length);
      });
      
      columnWidths[index] = { wch: Math.min(maxWidth + 2, 50) };
    });
    worksheet['!cols'] = columnWidths;

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Query Result');
    
    const metadataSheet = XLSX.utils.aoa_to_sheet([
      ['Property', 'Value'],
      ['Row Count', resultSet.rowCount],
      ['Execution Time (ms)', resultSet.executionTime || 0],
      ['Exported At', new Date().toISOString()],
      ['Columns', columns.length]
    ]);
    XLSX.utils.book_append_sheet(workbook, metadataSheet, 'Metadata');

    XLSX.writeFile(workbook, filePath);
  }

  private async exportToText(resultSet: ResultSet, filePath: string): Promise<void> {
    const lines: string[] = [];
    
    const columnWidths: number[] = [];
    const columns = resultSet.columns || [];
    columns.forEach((col: ResultMetadata, index: number) => {
      let maxWidth = col.name.length;
      
      resultSet.rows.forEach(row => {
        const value = this.formatValue(row[col.name]);
        maxWidth = Math.max(maxWidth, value.length);
      });
      
      columnWidths[index] = Math.min(maxWidth, 50);
    });

    const separator = '+' + columnWidths.map((w: number) => '-'.repeat(w + 2)).join('+') + '+';

    lines.push(separator);
    lines.push('|' + columns.map((col: ResultMetadata, i: number) => {
      const width = columnWidths[i];
      return width !== undefined ? ` ${col.name.padEnd(width)} ` : ` ${col.name} `;
    }).join('|') + '|');
    lines.push(separator);

    resultSet.rows.forEach(row => {
      lines.push('|' + columns.map((col: ResultMetadata, i: number) => {
        const value = this.formatValue(row[col.name]);
        const width = columnWidths[i];
        return width !== undefined ? ` ${value.padEnd(width)} ` : ` ${value} `;
      }).join('|') + '|');
    });

    lines.push(separator);
    lines.push(`\nTotal Rows: ${resultSet.rowCount}`);
    if (resultSet.executionTime) {
      lines.push(`Execution Time: ${resultSet.executionTime}ms`);
    }

    await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  }

  private async importFromCSV(filePath: string, _options?: any): Promise<any[]> {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter((line: string) => line.trim());
    
    if (lines.length === 0) return [];

    const firstLine = lines[0];
    if (!firstLine) return [];
    
    const headers = firstLine.split(',').map((h: string) => h.trim());
    const data: any[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      
      const values = this.parseCSVLine(line);
      const row: any = {};
      
      if (values) {
        headers.forEach((header: string, index: number) => {
          const value = values[index];
          row[header] = this.parseValue(value !== undefined ? value : '');
        });
        
        data.push(row);
      }
    }

    return data;
  }

  private async importFromJSON(filePath: string): Promise<any[]> {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    
    if (Array.isArray(parsed)) {
      return parsed;
    } else if (parsed.data && Array.isArray(parsed.data)) {
      return parsed.data;
    } else {
      throw new Error('Invalid JSON format: expected array or object with data property');
    }
  }

  private async importFromXML(filePath: string, _options?: any): Promise<any[]> {
    const content = await fs.readFile(filePath, 'utf8');
    const data: any[] = [];
    
    const contentStr = content;
    const rowMatches = contentStr.match(/<row>([\s\S]*?)<\/row>/g);
    if (!rowMatches) return [];

    rowMatches.forEach((rowXml: string) => {
      const row: any = {};
      
      const fieldMatches = rowXml.match(/<(\w+)>(.*?)<\/\1>/g);
      if (fieldMatches) {
        fieldMatches.forEach((fieldXml: string) => {
          const match = fieldXml.match(/<(\w+)>(.*?)<\/\1>/);
          if (match && match[1] && match[2]) {
            row[match[1]] = this.parseValue(match[2]);
          }
        });
      }
      
      data.push(row);
    });

    return data;
  }

  private async importFromExcel(filePath: string, options?: any): Promise<any[]> {
    const workbook = XLSX.readFile(filePath);
    const sheetName = options?.sheet || workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    const data = worksheet ? XLSX.utils.sheet_to_json(worksheet, {
      raw: false,
      dateNF: 'yyyy-mm-dd hh:mm:ss'
    }) : [];

    return data;
  }

  private parseCSVLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    values.push(current.trim());
    return values;
  }

  private parseValue(value: string): any {
    if (!value || value === 'null' || value === 'NULL') return null;
    
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return parseFloat(value);
    }
    
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    
    const date = new Date(value);
    if (!isNaN(date.getTime()) && value.includes('-') || value.includes('/')) {
      return date;
    }
    
    return value;
  }

  private formatValue(value: any): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  private escapeCSV(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private escapeXML(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
