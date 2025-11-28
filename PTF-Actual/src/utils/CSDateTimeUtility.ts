// src/utils/CSDateTimeUtility.ts

/**
 * Comprehensive DateTime Utility class
 * Provides extensive date/time parsing, formatting, manipulation, and comparison methods
 * Supports locale-aware and timezone-aware operations with default Americas locale (en-US)
 * and default Americas timezone (America/New_York)
 */
export class CSDateTimeUtility {

    // Default locale for all operations
    private static defaultLocale: string = 'en-US';

    // Default timezone for all operations (Americas timezone)
    private static defaultTimezone: string = 'America/New_York';

    /**
     * Set the default locale for all date operations
     * @param locale - Locale string (e.g., 'en-US', 'en-GB', 'fr-FR', 'de-DE', 'ja-JP')
     */
    static setDefaultLocale(locale: string): void {
        this.defaultLocale = locale;
    }

    /**
     * Get the current default locale
     */
    static getDefaultLocale(): string {
        return this.defaultLocale;
    }

    /**
     * Set the default timezone for all date operations
     * @param timezone - IANA timezone string (e.g., 'America/New_York', 'America/Los_Angeles', 'Europe/London')
     */
    static setDefaultTimezone(timezone: string): void {
        this.defaultTimezone = timezone;
    }

    /**
     * Get the current default timezone
     */
    static getDefaultTimezone(): string {
        return this.defaultTimezone;
    }

    // ===============================
    // DATE PARSING & CREATION
    // ===============================

    /**
     * Parse date from various string formats
     */
    static parse(dateString: string): Date | null {
        const date = new Date(dateString);
        return isNaN(date.getTime()) ? null : date;
    }

    /**
     * Create date from components
     */
    static create(year: number, month: number, day: number = 1, hour: number = 0, minute: number = 0, second: number = 0, millisecond: number = 0): Date {
        return new Date(year, month - 1, day, hour, minute, second, millisecond);
    }

    /**
     * Get current date/time
     */
    static now(): Date {
        return new Date();
    }

    /**
     * Get current timestamp in milliseconds
     */
    static timestamp(): number {
        return Date.now();
    }

    /**
     * Get current Unix timestamp in seconds
     */
    static unixTimestamp(): number {
        return Math.floor(Date.now() / 1000);
    }

    /**
     * Create date from Unix timestamp (seconds)
     */
    static fromUnixTimestamp(timestamp: number): Date {
        return new Date(timestamp * 1000);
    }

    /**
     * Create date from milliseconds timestamp
     */
    static fromTimestamp(timestamp: number): Date {
        return new Date(timestamp);
    }

    // ===============================
    // DATE FORMATTING
    // ===============================

    /**
     * Format date to ISO 8601 string (YYYY-MM-DDTHH:mm:ss.sssZ)
     */
    static toISO(date: Date): string {
        return date.toISOString();
    }

    /**
     * Format date to YYYY-MM-DD
     */
    static toDateString(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    /**
     * Format date to MM/DD/YYYY
     */
    static toUSDateString(date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = date.getFullYear();
        return `${month}/${day}/${year}`;
    }

    /**
     * Format date to DD/MM/YYYY
     */
    static toEUDateString(date: Date): string {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${day}/${month}/${year}`;
    }

    /**
     * Format time to HH:mm:ss
     */
    static toTimeString(date: Date): string {
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    }

    /**
     * Format date/time to YYYY-MM-DD HH:mm:ss
     */
    static toDateTimeString(date: Date): string {
        return `${this.toDateString(date)} ${this.toTimeString(date)}`;
    }

    /**
     * Format date with custom format
     * Supported tokens: YYYY, MM, DD, HH, mm, ss, SSS
     */
    static format(date: Date, format: string): string {
        const tokens: Record<string, string> = {
            'YYYY': String(date.getFullYear()),
            'YY': String(date.getFullYear()).slice(-2),
            'MM': String(date.getMonth() + 1).padStart(2, '0'),
            'M': String(date.getMonth() + 1),
            'DD': String(date.getDate()).padStart(2, '0'),
            'D': String(date.getDate()),
            'HH': String(date.getHours()).padStart(2, '0'),
            'H': String(date.getHours()),
            'hh': String(date.getHours() % 12 || 12).padStart(2, '0'),
            'h': String(date.getHours() % 12 || 12),
            'mm': String(date.getMinutes()).padStart(2, '0'),
            'm': String(date.getMinutes()),
            'ss': String(date.getSeconds()).padStart(2, '0'),
            's': String(date.getSeconds()),
            'SSS': String(date.getMilliseconds()).padStart(3, '0'),
            'A': date.getHours() >= 12 ? 'PM' : 'AM',
            'a': date.getHours() >= 12 ? 'pm' : 'am'
        };

        let result = format;
        for (const [token, value] of Object.entries(tokens)) {
            result = result.replace(new RegExp(token, 'g'), value);
        }
        return result;
    }

    /**
     * Format date to human-readable string
     * Example: "January 1, 2024" (en-US) or "1 janvier 2024" (fr-FR)
     * @param date - Date to format
     * @param locale - Locale string (defaults to Americas locale)
     */
    static toHumanString(date: Date, locale?: string): string {
        const targetLocale = locale || this.defaultLocale;
        return date.toLocaleDateString(targetLocale, {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }

    /**
     * Format date to relative time
     * Example: "2 hours ago", "in 3 days" (en-US) or uses Intl.RelativeTimeFormat for locale support
     * @param date - Date to format
     * @param baseDate - Reference date (defaults to now)
     * @param locale - Locale string (defaults to Americas locale)
     */
    static toRelative(date: Date, baseDate: Date = new Date(), locale?: string): string {
        const targetLocale = locale || this.defaultLocale;
        const diff = baseDate.getTime() - date.getTime();
        const seconds = Math.abs(Math.floor(diff / 1000));
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        const months = Math.floor(days / 30);
        const years = Math.floor(days / 365);

        const rtf = new Intl.RelativeTimeFormat(targetLocale, { numeric: 'auto' });
        const isPast = diff > 0;

        if (seconds < 60) return rtf.format(isPast ? -seconds : seconds, 'second');
        if (minutes < 60) return rtf.format(isPast ? -minutes : minutes, 'minute');
        if (hours < 24) return rtf.format(isPast ? -hours : hours, 'hour');
        if (days < 30) return rtf.format(isPast ? -days : days, 'day');
        if (months < 12) return rtf.format(isPast ? -months : months, 'month');
        return rtf.format(isPast ? -years : years, 'year');
    }

    private static pluralize(count: number, singular: string): string {
        return count === 1 ? singular : singular + 's';
    }

    // ===============================
    // DATE MANIPULATION
    // ===============================

    /**
     * Add years to date
     */
    static addYears(date: Date, years: number): Date {
        const result = new Date(date);
        result.setFullYear(result.getFullYear() + years);
        return result;
    }

    /**
     * Add months to date
     */
    static addMonths(date: Date, months: number): Date {
        const result = new Date(date);
        result.setMonth(result.getMonth() + months);
        return result;
    }

    /**
     * Add days to date
     */
    static addDays(date: Date, days: number): Date {
        const result = new Date(date);
        result.setDate(result.getDate() + days);
        return result;
    }

    /**
     * Add hours to date
     */
    static addHours(date: Date, hours: number): Date {
        const result = new Date(date);
        result.setHours(result.getHours() + hours);
        return result;
    }

    /**
     * Add minutes to date
     */
    static addMinutes(date: Date, minutes: number): Date {
        const result = new Date(date);
        result.setMinutes(result.getMinutes() + minutes);
        return result;
    }

    /**
     * Add seconds to date
     */
    static addSeconds(date: Date, seconds: number): Date {
        const result = new Date(date);
        result.setSeconds(result.getSeconds() + seconds);
        return result;
    }

    /**
     * Add milliseconds to date
     */
    static addMilliseconds(date: Date, milliseconds: number): Date {
        return new Date(date.getTime() + milliseconds);
    }

    /**
     * Subtract years from date
     */
    static subtractYears(date: Date, years: number): Date {
        return this.addYears(date, -years);
    }

    /**
     * Subtract months from date
     */
    static subtractMonths(date: Date, months: number): Date {
        return this.addMonths(date, -months);
    }

    /**
     * Subtract days from date
     */
    static subtractDays(date: Date, days: number): Date {
        return this.addDays(date, -days);
    }

    /**
     * Subtract hours from date
     */
    static subtractHours(date: Date, hours: number): Date {
        return this.addHours(date, -hours);
    }

    /**
     * Subtract minutes from date
     */
    static subtractMinutes(date: Date, minutes: number): Date {
        return this.addMinutes(date, -minutes);
    }

    /**
     * Subtract seconds from date
     */
    static subtractSeconds(date: Date, seconds: number): Date {
        return this.addSeconds(date, -seconds);
    }

    /**
     * Get start of day (00:00:00)
     */
    static startOfDay(date: Date): Date {
        const result = new Date(date);
        result.setHours(0, 0, 0, 0);
        return result;
    }

    /**
     * Get end of day (23:59:59.999)
     */
    static endOfDay(date: Date): Date {
        const result = new Date(date);
        result.setHours(23, 59, 59, 999);
        return result;
    }

    /**
     * Get start of week (Monday 00:00:00)
     */
    static startOfWeek(date: Date): Date {
        const result = new Date(date);
        const day = result.getDay();
        const diff = day === 0 ? -6 : 1 - day; // Adjust when day is Sunday
        result.setDate(result.getDate() + diff);
        return this.startOfDay(result);
    }

    /**
     * Get end of week (Sunday 23:59:59.999)
     */
    static endOfWeek(date: Date): Date {
        const result = this.startOfWeek(date);
        result.setDate(result.getDate() + 6);
        return this.endOfDay(result);
    }

    /**
     * Get start of month
     */
    static startOfMonth(date: Date): Date {
        const result = new Date(date);
        result.setDate(1);
        return this.startOfDay(result);
    }

    /**
     * Get end of month
     */
    static endOfMonth(date: Date): Date {
        const result = new Date(date);
        result.setMonth(result.getMonth() + 1, 0);
        return this.endOfDay(result);
    }

    /**
     * Get start of year
     */
    static startOfYear(date: Date): Date {
        const result = new Date(date);
        result.setMonth(0, 1);
        return this.startOfDay(result);
    }

    /**
     * Get end of year
     */
    static endOfYear(date: Date): Date {
        const result = new Date(date);
        result.setMonth(11, 31);
        return this.endOfDay(result);
    }

    // ===============================
    // DATE COMPARISON
    // ===============================

    /**
     * Check if two dates are equal
     */
    static equals(date1: Date, date2: Date): boolean {
        return date1.getTime() === date2.getTime();
    }

    /**
     * Check if date1 is before date2
     */
    static isBefore(date1: Date, date2: Date): boolean {
        return date1.getTime() < date2.getTime();
    }

    /**
     * Check if date1 is after date2
     */
    static isAfter(date1: Date, date2: Date): boolean {
        return date1.getTime() > date2.getTime();
    }

    /**
     * Check if date is between two dates (inclusive)
     */
    static isBetween(date: Date, start: Date, end: Date): boolean {
        const time = date.getTime();
        return time >= start.getTime() && time <= end.getTime();
    }

    /**
     * Check if two dates are on the same day
     */
    static isSameDay(date1: Date, date2: Date): boolean {
        return this.toDateString(date1) === this.toDateString(date2);
    }

    /**
     * Check if two dates are in the same week
     */
    static isSameWeek(date1: Date, date2: Date): boolean {
        const week1 = this.getWeekOfYear(date1);
        const week2 = this.getWeekOfYear(date2);
        return week1 === week2 && date1.getFullYear() === date2.getFullYear();
    }

    /**
     * Check if two dates are in the same month
     */
    static isSameMonth(date1: Date, date2: Date): boolean {
        return date1.getFullYear() === date2.getFullYear() &&
               date1.getMonth() === date2.getMonth();
    }

    /**
     * Check if two dates are in the same year
     */
    static isSameYear(date1: Date, date2: Date): boolean {
        return date1.getFullYear() === date2.getFullYear();
    }

    /**
     * Check if date is today
     */
    static isToday(date: Date): boolean {
        return this.isSameDay(date, new Date());
    }

    /**
     * Check if date is yesterday
     */
    static isYesterday(date: Date): boolean {
        const yesterday = this.subtractDays(new Date(), 1);
        return this.isSameDay(date, yesterday);
    }

    /**
     * Check if date is tomorrow
     */
    static isTomorrow(date: Date): boolean {
        const tomorrow = this.addDays(new Date(), 1);
        return this.isSameDay(date, tomorrow);
    }

    /**
     * Check if date is a weekend
     */
    static isWeekend(date: Date): boolean {
        const day = date.getDay();
        return day === 0 || day === 6;
    }

    /**
     * Check if date is a weekday
     */
    static isWeekday(date: Date): boolean {
        return !this.isWeekend(date);
    }

    /**
     * Check if date is in the past
     */
    static isPast(date: Date): boolean {
        return this.isBefore(date, new Date());
    }

    /**
     * Check if date is in the future
     */
    static isFuture(date: Date): boolean {
        return this.isAfter(date, new Date());
    }

    /**
     * Check if year is a leap year
     */
    static isLeapYear(year: number): boolean {
        return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    }

    // ===============================
    // DATE DIFFERENCE CALCULATIONS
    // ===============================

    /**
     * Get difference in milliseconds
     */
    static diffInMilliseconds(date1: Date, date2: Date): number {
        return Math.abs(date1.getTime() - date2.getTime());
    }

    /**
     * Get difference in seconds
     */
    static diffInSeconds(date1: Date, date2: Date): number {
        return Math.floor(this.diffInMilliseconds(date1, date2) / 1000);
    }

    /**
     * Get difference in minutes
     */
    static diffInMinutes(date1: Date, date2: Date): number {
        return Math.floor(this.diffInSeconds(date1, date2) / 60);
    }

    /**
     * Get difference in hours
     */
    static diffInHours(date1: Date, date2: Date): number {
        return Math.floor(this.diffInMinutes(date1, date2) / 60);
    }

    /**
     * Get difference in days
     */
    static diffInDays(date1: Date, date2: Date): number {
        return Math.floor(this.diffInHours(date1, date2) / 24);
    }

    /**
     * Get difference in weeks
     */
    static diffInWeeks(date1: Date, date2: Date): number {
        return Math.floor(this.diffInDays(date1, date2) / 7);
    }

    /**
     * Get difference in months (approximate)
     */
    static diffInMonths(date1: Date, date2: Date): number {
        const yearDiff = date1.getFullYear() - date2.getFullYear();
        const monthDiff = date1.getMonth() - date2.getMonth();
        return Math.abs(yearDiff * 12 + monthDiff);
    }

    /**
     * Get difference in years
     */
    static diffInYears(date1: Date, date2: Date): number {
        return Math.abs(date1.getFullYear() - date2.getFullYear());
    }

    /**
     * Get age from birthdate
     */
    static getAge(birthdate: Date, referenceDate: Date = new Date()): number {
        let age = referenceDate.getFullYear() - birthdate.getFullYear();
        const monthDiff = referenceDate.getMonth() - birthdate.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getDate() < birthdate.getDate())) {
            age--;
        }
        return age;
    }

    // ===============================
    // DATE INFORMATION
    // ===============================

    /**
     * Get day of week (0-6, Sunday-Saturday)
     */
    static getDayOfWeek(date: Date): number {
        return date.getDay();
    }

    /**
     * Get day of week name
     * @param date - Date to get day name from
     * @param short - Return short format (Mon) vs long format (Monday)
     * @param locale - Locale string (defaults to Americas locale)
     */
    static getDayOfWeekName(date: Date, short: boolean = false, locale?: string): string {
        const targetLocale = locale || this.defaultLocale;
        return date.toLocaleDateString(targetLocale, { weekday: short ? 'short' : 'long' });
    }

    /**
     * Get month name
     * @param date - Date to get month name from
     * @param short - Return short format (Jan) vs long format (January)
     * @param locale - Locale string (defaults to Americas locale)
     */
    static getMonthName(date: Date, short: boolean = false, locale?: string): string {
        const targetLocale = locale || this.defaultLocale;
        return date.toLocaleDateString(targetLocale, { month: short ? 'short' : 'long' });
    }

    /**
     * Get day of year (1-366)
     */
    static getDayOfYear(date: Date): number {
        const start = new Date(date.getFullYear(), 0, 0);
        const diff = date.getTime() - start.getTime();
        const oneDay = 1000 * 60 * 60 * 24;
        return Math.floor(diff / oneDay);
    }

    /**
     * Get week of year (1-53)
     */
    static getWeekOfYear(date: Date): number {
        const firstDay = new Date(date.getFullYear(), 0, 1);
        const pastDays = this.diffInDays(date, firstDay);
        return Math.ceil((pastDays + firstDay.getDay() + 1) / 7);
    }

    /**
     * Get days in month
     */
    static getDaysInMonth(date: Date): number {
        return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    }

    /**
     * Get days in year
     */
    static getDaysInYear(year: number): number {
        return this.isLeapYear(year) ? 366 : 365;
    }

    /**
     * Get quarter (1-4)
     */
    static getQuarter(date: Date): number {
        return Math.floor(date.getMonth() / 3) + 1;
    }

    // ===============================
    // TIMEZONE OPERATIONS
    // ===============================

    /**
     * Get timezone offset in minutes
     */
    static getTimezoneOffset(date: Date = new Date()): number {
        return date.getTimezoneOffset();
    }

    /**
     * Convert date to UTC
     */
    static toUTC(date: Date): Date {
        return new Date(date.getTime() + date.getTimezoneOffset() * 60000);
    }

    /**
     * Convert date from UTC to local time
     */
    static fromUTC(date: Date): Date {
        return new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    }

    /**
     * Get date components (year, month, day, hour, minute, second) in a specific timezone
     * @param date - Date to get components from
     * @param timezone - IANA timezone string (defaults to defaultTimezone)
     * @returns Object with year, month (1-12), day, hour, minute, second
     */
    static getDateComponentsInTimezone(date: Date, timezone?: string): { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number } {
        const tz = timezone || this.defaultTimezone;
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });

        const parts = formatter.formatToParts(date);
        const getValue = (type: string): number => {
            const part = parts.find(p => p.type === type);
            return part ? parseInt(part.value, 10) : 0;
        };

        return {
            year: getValue('year'),
            month: getValue('month'),
            day: getValue('day'),
            hour: getValue('hour') === 24 ? 0 : getValue('hour'), // Handle midnight edge case
            minute: getValue('minute'),
            second: getValue('second'),
            millisecond: date.getMilliseconds() // Milliseconds are the same across timezones
        };
    }

    /**
     * Format date to YYYY-MM-DD in the default timezone (Americas)
     * This ensures dates are always in Americas timezone regardless of system timezone
     * @param date - Date to format
     * @param timezone - IANA timezone string (defaults to defaultTimezone - America/New_York)
     */
    static toDateStringInTimezone(date: Date, timezone?: string): string {
        const components = this.getDateComponentsInTimezone(date, timezone);
        return `${components.year}-${String(components.month).padStart(2, '0')}-${String(components.day).padStart(2, '0')}`;
    }

    /**
     * Format date to MM/DD/YYYY in the default timezone (Americas)
     * @param date - Date to format
     * @param timezone - IANA timezone string (defaults to defaultTimezone)
     */
    static toUSDateStringInTimezone(date: Date, timezone?: string): string {
        const components = this.getDateComponentsInTimezone(date, timezone);
        return `${String(components.month).padStart(2, '0')}/${String(components.day).padStart(2, '0')}/${components.year}`;
    }

    /**
     * Format time to HH:mm:ss in the default timezone (Americas)
     * @param date - Date to format
     * @param timezone - IANA timezone string (defaults to defaultTimezone)
     */
    static toTimeStringInTimezone(date: Date, timezone?: string): string {
        const components = this.getDateComponentsInTimezone(date, timezone);
        return `${String(components.hour).padStart(2, '0')}:${String(components.minute).padStart(2, '0')}:${String(components.second).padStart(2, '0')}`;
    }

    /**
     * Format date/time to YYYY-MM-DD HH:mm:ss in the default timezone (Americas)
     * @param date - Date to format
     * @param timezone - IANA timezone string (defaults to defaultTimezone)
     */
    static toDateTimeStringInTimezone(date: Date, timezone?: string): string {
        return `${this.toDateStringInTimezone(date, timezone)} ${this.toTimeStringInTimezone(date, timezone)}`;
    }

    /**
     * Format date with custom format in the default timezone (Americas)
     * Supported tokens: YYYY, MM, DD, HH, mm, ss, SSS
     * @param date - Date to format
     * @param format - Format string
     * @param timezone - IANA timezone string (defaults to defaultTimezone)
     */
    static formatInTimezone(date: Date, format: string, timezone?: string): string {
        const c = this.getDateComponentsInTimezone(date, timezone);

        const tokens: Record<string, string> = {
            'YYYY': String(c.year),
            'YY': String(c.year).slice(-2),
            'MM': String(c.month).padStart(2, '0'),
            'M': String(c.month),
            'DD': String(c.day).padStart(2, '0'),
            'D': String(c.day),
            'HH': String(c.hour).padStart(2, '0'),
            'H': String(c.hour),
            'hh': String(c.hour % 12 || 12).padStart(2, '0'),
            'h': String(c.hour % 12 || 12),
            'mm': String(c.minute).padStart(2, '0'),
            'm': String(c.minute),
            'ss': String(c.second).padStart(2, '0'),
            's': String(c.second),
            'SSS': String(c.millisecond).padStart(3, '0'),
            'A': c.hour >= 12 ? 'PM' : 'AM',
            'a': c.hour >= 12 ? 'pm' : 'am'
        };

        let result = format;
        // Sort tokens by length descending to avoid partial replacements (e.g., 'MM' before 'M')
        const sortedTokens = Object.keys(tokens).sort((a, b) => b.length - a.length);
        for (const token of sortedTokens) {
            result = result.replace(new RegExp(token, 'g'), tokens[token]);
        }
        return result;
    }

    /**
     * Get current date string in Americas timezone (YYYY-MM-DD)
     * This is a convenience method to get today's date in Americas timezone
     * regardless of the system's local timezone
     */
    static getTodayInAmericasTimezone(): string {
        return this.toDateStringInTimezone(new Date());
    }

    /**
     * Get current datetime string in Americas timezone (YYYY-MM-DD HH:mm:ss)
     */
    static getNowInAmericasTimezone(): string {
        return this.toDateTimeStringInTimezone(new Date());
    }

    /**
     * Check if date is today in the default timezone (Americas)
     * @param date - Date to check
     * @param timezone - IANA timezone string (defaults to defaultTimezone)
     */
    static isTodayInTimezone(date: Date, timezone?: string): boolean {
        const dateStr = this.toDateStringInTimezone(date, timezone);
        const todayStr = this.toDateStringInTimezone(new Date(), timezone);
        return dateStr === todayStr;
    }

    // ===============================
    // VALIDATION
    // ===============================

    /**
     * Check if date is valid
     */
    static isValid(date: any): boolean {
        return date instanceof Date && !isNaN(date.getTime());
    }

    /**
     * Validate date string format (YYYY-MM-DD)
     */
    static isValidDateString(dateString: string): boolean {
        const regex = /^\d{4}-\d{2}-\d{2}$/;
        if (!regex.test(dateString)) return false;

        const date = new Date(dateString);
        return this.isValid(date);
    }

    /**
     * Validate datetime string format (YYYY-MM-DD HH:mm:ss)
     */
    static isValidDateTimeString(dateTimeString: string): boolean {
        const regex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
        if (!regex.test(dateTimeString)) return false;

        const date = new Date(dateTimeString.replace(' ', 'T'));
        return this.isValid(date);
    }

    // ===============================
    // BUSINESS DATE CALCULATIONS
    // ===============================

    /**
     * Add business days (excluding weekends)
     */
    static addBusinessDays(date: Date, days: number): Date {
        let result = new Date(date);
        let addedDays = 0;

        while (addedDays < Math.abs(days)) {
            result = this.addDays(result, days > 0 ? 1 : -1);
            if (this.isWeekday(result)) {
                addedDays++;
            }
        }

        return result;
    }

    /**
     * Count business days between two dates
     */
    static countBusinessDays(startDate: Date, endDate: Date): number {
        let count = 0;
        let current = new Date(startDate);

        while (current <= endDate) {
            if (this.isWeekday(current)) {
                count++;
            }
            current = this.addDays(current, 1);
        }

        return count;
    }

    // ===================================
    // LOCALE-AWARE FORMATTING
    // ===================================

    /**
     * Format date with locale-specific formatting
     * @param date - Date to format
     * @param options - Intl.DateTimeFormatOptions
     * @param locale - Locale string (defaults to Americas locale)
     */
    static toLocaleString(date: Date, options?: Intl.DateTimeFormatOptions, locale?: string): string {
        const targetLocale = locale || this.defaultLocale;
        return date.toLocaleString(targetLocale, options);
    }

    /**
     * Format date (date only) with locale-specific formatting
     * @param date - Date to format
     * @param options - Intl.DateTimeFormatOptions
     * @param locale - Locale string (defaults to Americas locale)
     */
    static toLocaleDateString(date: Date, options?: Intl.DateTimeFormatOptions, locale?: string): string {
        const targetLocale = locale || this.defaultLocale;
        return date.toLocaleDateString(targetLocale, options);
    }

    /**
     * Format time with locale-specific formatting
     * @param date - Date to format
     * @param options - Intl.DateTimeFormatOptions
     * @param locale - Locale string (defaults to Americas locale)
     */
    static toLocaleTimeString(date: Date, options?: Intl.DateTimeFormatOptions, locale?: string): string {
        const targetLocale = locale || this.defaultLocale;
        return date.toLocaleTimeString(targetLocale, options);
    }

    /**
     * Format number with locale-specific formatting (useful for dates with numbers)
     * @param value - Number to format
     * @param locale - Locale string (defaults to Americas locale)
     */
    static formatNumber(value: number, locale?: string): string {
        const targetLocale = locale || this.defaultLocale;
        return new Intl.NumberFormat(targetLocale).format(value);
    }

    /**
     * Get locale-specific date format pattern
     * @param locale - Locale string (defaults to Americas locale)
     * @returns Example: "MM/DD/YYYY" for en-US, "DD/MM/YYYY" for en-GB
     */
    static getLocaleDateFormat(locale?: string): string {
        const targetLocale = locale || this.defaultLocale;
        const formatter = new Intl.DateTimeFormat(targetLocale);
        const parts = formatter.formatToParts(new Date(2024, 0, 15)); // Jan 15, 2024

        return parts
            .map(part => {
                if (part.type === 'month') return 'MM';
                if (part.type === 'day') return 'DD';
                if (part.type === 'year') return 'YYYY';
                return part.value;
            })
            .join('');
    }

    /**
     * Get first day of week for locale (0 = Sunday, 1 = Monday)
     * @param locale - Locale string (defaults to Americas locale)
     */
    static getFirstDayOfWeek(locale?: string): number {
        const targetLocale = locale || this.defaultLocale;
        // Most Americas locales start with Sunday (0), Europe with Monday (1)
        const europeanLocales = ['de', 'fr', 'es', 'it', 'nl', 'pl', 'pt', 'ru', 'sv', 'fi', 'no', 'da'];
        const lang = targetLocale.split('-')[0];
        return europeanLocales.includes(lang) ? 1 : 0;
    }
}
