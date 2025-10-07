import { faker } from '@faker-js/faker';
import * as fs from 'fs';
import * as path from 'path';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';

export interface DataGeneratorOptions {
    locale?: string;
    seed?: number;
    format?: 'json' | 'csv' | 'xml' | 'yaml';
    count?: number;
}

export interface PersonData {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    address: AddressData;
    dateOfBirth: Date;
    age: number;
    gender: string;
    username: string;
    password: string;
    avatar?: string;
}

export interface AddressData {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
    latitude: number;
    longitude: number;
}

export interface CompanyData {
    name: string;
    industry: string;
    catchPhrase: string;
    website: string;
    email: string;
    phone: string;
    address: AddressData;
    employees: number;
    founded: Date;
}

export interface ProductData {
    id: string;
    name: string;
    description: string;
    price: number;
    currency: string;
    category: string;
    sku: string;
    inStock: boolean;
    quantity: number;
    images: string[];
    rating: number;
    reviews: number;
}

export class CSDataGenerator {
    private static instance: CSDataGenerator;
    private config: CSConfigurationManager;
    private dataCache: Map<string, any> = new Map();
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        
        // Set locale if configured
        const locale = this.config.get('DATA_LOCALE', 'en_US');
        // Note: faker.locale is handled through imports in newer versions
        
        // Set seed for reproducible data if configured
        const seed = this.config.getNumber('DATA_SEED');
        if (seed) {
            faker.seed(seed);
        }
    }
    
    public static getInstance(): CSDataGenerator {
        if (!CSDataGenerator.instance) {
            CSDataGenerator.instance = new CSDataGenerator();
        }
        return CSDataGenerator.instance;
    }
    
    // Person data generation
    public generatePerson(options: Partial<PersonData> = {}): PersonData {
        const firstName = options.firstName || faker.person.firstName();
        const lastName = options.lastName || faker.person.lastName();
        
        return {
            firstName,
            lastName,
            email: options.email || faker.internet.email({ firstName, lastName }),
            phone: options.phone || faker.phone.number(),
            address: options.address || this.generateAddress(),
            dateOfBirth: options.dateOfBirth || faker.date.birthdate({ min: 18, max: 80, mode: 'age' }),
            age: options.age || faker.number.int({ min: 18, max: 80 }),
            gender: options.gender || faker.person.gender(),
            username: options.username || faker.internet.username({ firstName, lastName }),
            password: options.password || this.generatePassword(),
            avatar: options.avatar || faker.image.avatar()
        };
    }
    
    public generatePeople(count: number, template?: Partial<PersonData>): PersonData[] {
        return Array.from({ length: count }, () => this.generatePerson(template));
    }
    
    // Address data generation
    public generateAddress(options: Partial<AddressData> = {}): AddressData {
        return {
            street: options.street || faker.location.streetAddress(),
            city: options.city || faker.location.city(),
            state: options.state || faker.location.state(),
            zipCode: options.zipCode || faker.location.zipCode(),
            country: options.country || faker.location.country(),
            latitude: options.latitude || faker.location.latitude(),
            longitude: options.longitude || faker.location.longitude()
        };
    }
    
    // Company data generation
    public generateCompany(options: Partial<CompanyData> = {}): CompanyData {
        return {
            name: options.name || faker.company.name(),
            industry: options.industry || faker.company.buzzNoun(),
            catchPhrase: options.catchPhrase || faker.company.catchPhrase(),
            website: options.website || faker.internet.url(),
            email: options.email || faker.internet.email(),
            phone: options.phone || faker.phone.number(),
            address: options.address || this.generateAddress(),
            employees: options.employees || faker.number.int({ min: 1, max: 10000 }),
            founded: options.founded || faker.date.past({ years: 50 })
        };
    }
    
    public generateCompanies(count: number, template?: Partial<CompanyData>): CompanyData[] {
        return Array.from({ length: count }, () => this.generateCompany(template));
    }
    
    // Product data generation
    public generateProduct(options: Partial<ProductData> = {}): ProductData {
        return {
            id: options.id || faker.string.uuid(),
            name: options.name || faker.commerce.productName(),
            description: options.description || faker.commerce.productDescription(),
            price: options.price || parseFloat(faker.commerce.price()),
            currency: options.currency || 'USD',
            category: options.category || faker.commerce.department(),
            sku: options.sku || faker.string.alphanumeric(8).toUpperCase(),
            inStock: options.inStock !== undefined ? options.inStock : faker.datatype.boolean(),
            quantity: options.quantity || faker.number.int({ min: 0, max: 1000 }),
            images: options.images || [faker.image.url(), faker.image.url()],
            rating: options.rating || faker.number.float({ min: 1, max: 5, fractionDigits: 1 }),
            reviews: options.reviews || faker.number.int({ min: 0, max: 500 })
        };
    }
    
    public generateProducts(count: number, template?: Partial<ProductData>): ProductData[] {
        return Array.from({ length: count }, () => this.generateProduct(template));
    }
    
    // Credential generation
    public generateEmail(options: { firstName?: string; lastName?: string; domain?: string } = {}): string {
        return faker.internet.email({
            firstName: options.firstName,
            lastName: options.lastName,
            provider: options.domain
        });
    }
    
    public generateUsername(options: { firstName?: string; lastName?: string } = {}): string {
        return faker.internet.username({
            firstName: options.firstName,
            lastName: options.lastName
        });
    }
    
    public generatePassword(options: {
        length?: number;
        memorable?: boolean;
        pattern?: RegExp;
        prefix?: string;
    } = {}): string {
        if (options.memorable) {
            return faker.internet.password({ length: options.length || 20, memorable: true });
        }
        
        if (options.pattern) {
            return faker.helpers.fromRegExp(options.pattern);
        }
        
        const password = faker.internet.password({ length: options.length || 12 });
        return options.prefix ? `${options.prefix}${password}` : password;
    }
    
    // Number generation
    public generateNumber(min: number = 0, max: number = 100): number {
        return faker.number.int({ min, max });
    }
    
    public generateFloat(min: number = 0, max: number = 100, precision: number = 2): number {
        return faker.number.float({ min, max, fractionDigits: precision });
    }
    
    public generatePhoneNumber(format?: string): string {
        // In newer faker versions, phone.number() doesn't take a format parameter
        return faker.phone.number();
    }
    
    // Date generation
    public generateDate(options: {
        from?: Date;
        to?: Date;
        past?: number;
        future?: number;
    } = {}): Date {
        if (options.from && options.to) {
            return faker.date.between({ from: options.from, to: options.to });
        }
        
        if (options.past) {
            return faker.date.past({ years: options.past });
        }
        
        if (options.future) {
            return faker.date.future({ years: options.future });
        }
        
        return faker.date.recent();
    }
    
    public generateDateString(format: string = 'YYYY-MM-DD'): string {
        const date = this.generateDate();
        return this.formatDate(date, format);
    }
    
    private formatDate(date: Date, format: string): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        return format
            .replace('YYYY', String(year))
            .replace('MM', month)
            .replace('DD', day);
    }
    
    // Text generation
    public generateText(words: number = 10): string {
        return faker.lorem.words(words);
    }
    
    public generateParagraph(sentences: number = 3): string {
        return faker.lorem.paragraph(sentences);
    }
    
    public generateSentence(words: number = 7): string {
        return faker.lorem.sentence(words);
    }
    
    // ID generation
    public generateUUID(): string {
        return faker.string.uuid();
    }
    
    public generateId(prefix?: string, length: number = 8): string {
        const id = faker.string.alphanumeric(length);
        return prefix ? `${prefix}_${id}` : id;
    }
    
    // File generation
    public generateFileName(extension?: string): string {
        const name = faker.system.fileName();
        if (extension) {
            return name.replace(/\.[^/.]+$/, `.${extension}`);
        }
        return name;
    }
    
    public generateFilePath(): string {
        return faker.system.filePath();
    }
    
    // URL generation
    public generateUrl(options: { protocol?: string; domain?: string } = {}): string {
        return faker.internet.url({ protocol: options.protocol as any });
    }
    
    public generateImageUrl(width: number = 640, height: number = 480): string {
        return faker.image.url({ width, height });
    }
    
    // Credit card generation
    public generateCreditCard(): {
        number: string;
        cvv: string;
        expiryDate: string;
        type: string;
    } {
        return {
            number: faker.finance.creditCardNumber(),
            cvv: faker.finance.creditCardCVV(),
            expiryDate: `${faker.number.int({ min: 1, max: 12 })}/${faker.number.int({ min: 24, max: 30 })}`,
            type: faker.finance.creditCardIssuer()
        };
    }
    
    // Custom data generation from template
    public generateFromTemplate(template: any): any {
        if (typeof template === 'string') {
            // Handle template strings with placeholders
            return template.replace(/\{\{(\w+)(?:\.(\w+))?\}\}/g, (match, category, method) => {
                try {
                    if (method) {
                        return (faker as any)[category][method]();
                    }
                    return (faker as any)[category]();
                } catch {
                    return match;
                }
            });
        }
        
        if (Array.isArray(template)) {
            return template.map(item => this.generateFromTemplate(item));
        }
        
        if (typeof template === 'object' && template !== null) {
            const result: any = {};
            for (const [key, value] of Object.entries(template)) {
                result[key] = this.generateFromTemplate(value);
            }
            return result;
        }
        
        return template;
    }
    
    // Bulk data generation
    public generateBulkData(schema: any, count: number): any[] {
        return Array.from({ length: count }, () => this.generateFromTemplate(schema));
    }
    
    // Data export
    public async exportData(data: any, filepath: string, format: 'json' | 'csv' | 'xml' | 'yaml' = 'json'): Promise<void> {
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        let content: string;
        
        switch (format) {
            case 'json':
                content = JSON.stringify(data, null, 2);
                break;
            case 'csv':
                content = this.convertToCSV(data);
                break;
            case 'xml':
                content = this.convertToXML(data);
                break;
            case 'yaml':
                content = this.convertToYAML(data);
                break;
            default:
                content = JSON.stringify(data);
        }
        
        fs.writeFileSync(filepath, content);
        CSReporter.info(`Data exported to: ${filepath}`);
    }
    
    private convertToCSV(data: any[]): string {
        if (!Array.isArray(data) || data.length === 0) return '';
        
        const headers = Object.keys(data[0]);
        const rows = data.map(item => 
            headers.map(header => {
                const value = item[header];
                return typeof value === 'string' && value.includes(',') 
                    ? `"${value}"` 
                    : value;
            }).join(',')
        );
        
        return [headers.join(','), ...rows].join('\n');
    }
    
    private convertToXML(data: any): string {
        const toXML = (obj: any, rootName: string = 'root'): string => {
            if (Array.isArray(obj)) {
                return `<${rootName}>${obj.map(item => toXML(item, 'item')).join('')}</${rootName}>`;
            }
            
            if (typeof obj === 'object' && obj !== null) {
                const content = Object.entries(obj)
                    .map(([key, value]) => toXML(value, key))
                    .join('');
                return `<${rootName}>${content}</${rootName}>`;
            }
            
            return `<${rootName}>${obj}</${rootName}>`;
        };
        
        return `<?xml version="1.0" encoding="UTF-8"?>\n${toXML(data)}`;
    }
    
    private convertToYAML(data: any): string {
        // Simplified YAML conversion
        const toYAML = (obj: any, indent: number = 0): string => {
            const spaces = ' '.repeat(indent);
            
            if (Array.isArray(obj)) {
                return obj.map(item => `${spaces}- ${toYAML(item, indent + 2)}`).join('\n');
            }
            
            if (typeof obj === 'object' && obj !== null) {
                return Object.entries(obj)
                    .map(([key, value]) => {
                        if (typeof value === 'object') {
                            return `${spaces}${key}:\n${toYAML(value, indent + 2)}`;
                        }
                        return `${spaces}${key}: ${value}`;
                    })
                    .join('\n');
            }
            
            return String(obj);
        };
        
        return toYAML(data);
    }
    
    // Cache management
    public cacheData(key: string, data: any): void {
        this.dataCache.set(key, data);
    }
    
    public getCachedData(key: string): any {
        return this.dataCache.get(key);
    }
    
    public clearCache(): void {
        this.dataCache.clear();
    }
    
    // Seed management
    public setSeed(seed: number): void {
        faker.seed(seed);
    }
    
    public setLocale(locale: string): void {
        // Note: faker.locale property doesn't exist in newer versions
        // Locale is handled through different faker imports
        CSReporter.warn('setLocale is deprecated in newer faker versions');
    }
}