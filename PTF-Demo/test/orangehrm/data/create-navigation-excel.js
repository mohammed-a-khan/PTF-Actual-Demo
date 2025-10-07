const XLSX = require('xlsx');

// Create navigation test data
const navigationData = [
    { moduleName: 'Admin', expectedHeader: 'Admin', urlFragment: 'admin' },
    { moduleName: 'PIM', expectedHeader: 'PIM', urlFragment: 'pim' },
    { moduleName: 'Leave', expectedHeader: 'Leave', urlFragment: 'leave' },
    { moduleName: 'Time', expectedHeader: 'Time', urlFragment: 'time' },
    { moduleName: 'Recruitment', expectedHeader: 'Recruitment', urlFragment: 'recruitment' },
    { moduleName: 'My Info', expectedHeader: 'My Info', urlFragment: 'pim/viewPersonalDetails' },
    { moduleName: 'Performance', expectedHeader: 'Performance', urlFragment: 'performance' },
    { moduleName: 'Dashboard', expectedHeader: 'Dashboard', urlFragment: 'dashboard' }
];

// Create workbook
const wb = XLSX.utils.book_new();

// Create Modules sheet
const ws = XLSX.utils.json_to_sheet(navigationData);
XLSX.utils.book_append_sheet(wb, ws, 'Modules');

// Write file
XLSX.writeFile(wb, 'navigation.xlsx');

console.log('Navigation Excel file created successfully: navigation.xlsx');