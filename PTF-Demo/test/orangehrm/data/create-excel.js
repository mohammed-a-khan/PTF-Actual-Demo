const XLSX = require('xlsx');

// Create test data
const data = [
    { username: 'Admin', password: 'admin123', role: 'Admin', expectedResult: 'success', description: 'Valid admin login - Excel' },
    { username: 'TestUser', password: 'test123', role: 'User', expectedResult: 'success', description: 'Test user login' },
    { username: 'Manager', password: 'mgr123', role: 'Manager', expectedResult: 'success', description: 'Manager login' },
    { username: 'InvalidUser', password: 'wrongpass', role: 'None', expectedResult: 'failure', description: 'Invalid credentials - Excel' },
    { username: 'excel_<random>', password: 'excel123', role: 'Excel', expectedResult: 'failure', description: 'Excel test with random' },
    { username: '<generate:username>', password: '<generate:password>', role: 'Generated', expectedResult: 'failure', description: 'Generated from Excel' },
    { username: 'date_<date:YYYY-MM-DD>', password: 'date123', role: 'Date', expectedResult: 'failure', description: 'Date placeholder test' },
    { username: '=CONCAT("user_", "test")', password: 'formula123', role: 'Formula', expectedResult: 'failure', description: 'Excel formula test' },
    { username: 'spaces user', password: 'spaces pass', role: 'Spaces', expectedResult: 'failure', description: 'Username with spaces' },
    { username: 'UPPERCASE', password: 'UPPERCASE', role: 'Case', expectedResult: 'failure', description: 'All uppercase test' },
    { username: 'lowercase', password: 'lowercase', role: 'Case', expectedResult: 'failure', description: 'All lowercase test' },
    { username: 'Mixed_Case_123', password: 'MixedPass!@#', role: 'Mixed', expectedResult: 'failure', description: 'Mixed case and special' },
    { username: 'unicode_用户', password: 'unicode_密码', role: 'Unicode', expectedResult: 'failure', description: 'Unicode characters' },
    { username: 'tab\tuser', password: 'tab\tpass', role: 'Tab', expectedResult: 'failure', description: 'Tab characters' },
    { username: 'newline\nuser', password: 'newline\npass', role: 'Newline', expectedResult: 'failure', description: 'Newline characters' }
];

// Create workbook
const wb = XLSX.utils.book_new();

// Create worksheet from data
const ws = XLSX.utils.json_to_sheet(data);

// Add worksheet to workbook
XLSX.utils.book_append_sheet(wb, ws, 'Users');

// Create second sheet with different data
const performanceData = [
    { testCase: 'Login_Performance', username: 'Admin', responseTime: 1500, threshold: 2000, status: 'Pass' },
    { testCase: 'Bulk_Login', username: 'Multiple', responseTime: 5000, threshold: 6000, status: 'Pass' },
    { testCase: 'Concurrent_Login', username: 'Concurrent', responseTime: 3000, threshold: 2500, status: 'Fail' }
];

const ws2 = XLSX.utils.json_to_sheet(performanceData);
XLSX.utils.book_append_sheet(wb, ws2, 'Performance');

// Write file
XLSX.writeFile(wb, 'users.xlsx');

console.log('Excel file created successfully: users.xlsx');