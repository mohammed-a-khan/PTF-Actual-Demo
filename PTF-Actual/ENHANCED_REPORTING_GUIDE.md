# Enhanced Reporting Guide - Excel & PDF Reports

## Overview

The CS Test Automation Framework now generates **three attractive report formats** from a single test execution:

1. **HTML Report** - Interactive web-based report with charts and KPIs
2. **Excel Report** - Professional Excel workbook with multiple worksheets and modern styling
3. **PDF Report** - Print-ready PDF document generated from HTML using Playwright

All three reports are generated automatically after each test execution when enabled in configuration.

---

## Features

### 📊 Excel Report Features

The Excel report (`test-report.xlsx`) includes **7 comprehensive worksheets**:

#### 1. 📊 Dashboard
- **Executive KPI Cards**: Total Scenarios, Pass Rate, Duration, Passed, Failed, Skipped
- **Step Statistics Summary**: Total steps, pass rate, breakdown by status
- **Features Breakdown Table**: Test coverage by feature with pass/fail/skip counts
- Color-coded with brand colors (#93186C)

#### 2. 🎬 Test Scenarios
- Complete list of all test scenarios
- Columns: Index, Scenario Name, Feature, Status, Duration, Steps, Tags, Start Time
- Status color coding:
  - ✅ **Green** - Passed tests
  - ❌ **Red** - Failed tests
  - ⊘ **Orange** - Skipped tests
- Auto-filter enabled for easy searching
- Frozen header row for scrolling

#### 3. 📝 Test Steps
- Detailed breakdown of every test step
- Columns: Scenario, Step #, Step Name, Status, Duration, Error
- Color-coded status cells
- Error messages highlighted in red background
- Frozen header for navigation

#### 4. 🔍 Failure Analysis
- Summary of total failures
- **Failure Categories** with counts and percentages:
  - Timeout
  - Element Not Found
  - Assertion Failed
  - Network Error
  - Type Error
  - Other
- **Failed Scenarios Details** with step-by-step error messages

#### 5. ⚡ Performance
- Total execution time and metrics
- Average scenario duration
- Scenarios per minute throughput
- **🚀 Fastest Scenarios** (Top 10)
- **🐌 Slowest Scenarios** (Top 10)
- Color-coded performance cells

#### 6. 📈 History
- Execution history (last 100 runs)
- Columns: Date, Time, Total, Passed, Failed, Skipped, Pass Rate %, Duration
- Pass rate color coding:
  - **Green** - 90%+ pass rate
  - **Yellow** - 70-89% pass rate
  - **Red** - Below 70% pass rate
- Most recent executions first
- Trend analysis ready

#### 7. 📊 Charts Data
- Raw data for trend analysis
- Status distribution data
- Last 7 days execution trend
- Ready for pivot charts and custom visualizations

### 📄 PDF Report Features

The PDF report (`test-report.pdf`) offers:

- **Professional Layout**: A4 format with proper margins
- **Print Background**: All charts, colors, and styling preserved
- **Header/Footer**: Branded headers with page numbers
- **Generated Timestamp**: When the report was created
- **All Dashboard Content**: KPIs, charts, and statistics
- **Print-Optimized**: Page breaks optimized for readability

**Advanced Options:**
- `test-report-custom.pdf` - Customizable orientation, page size, screenshot inclusion
- Multi-view PDFs - Separate PDFs for Dashboard, Tests, Failures, Timeline views

---

## Configuration

### Enable/Disable Report Formats

Edit `config/global.env`:

```properties
# Generate Excel report (.xlsx) with modern KPIs and charts
GENERATE_EXCEL_REPORT=true

# Generate PDF report using Playwright (from HTML report)
GENERATE_PDF_REPORT=true
```

### Report Output Location

All reports are generated in the same directory:

```
reports/
├── YYYY-MM-DD_HH-MM-SS/          # Timestamp folder (if enabled)
│   ├── index.html                 # Interactive HTML report
│   ├── test-report.xlsx           # Excel workbook
│   ├── test-report.pdf            # PDF report
│   ├── report-data.json           # JSON data
│   ├── screenshots/               # Test screenshots
│   ├── videos/                    # Test recordings
│   └── traces/                    # Playwright traces
└── execution-history.json         # Historical trend data
```

---

## Excel Report Details

### Modern KPI Design

Each worksheet uses professional styling:
- **Brand Colors**: #93186C (primary), with green, red, orange accents
- **Borders**: Clean thin borders for all data tables
- **Fonts**: Bold headers, readable body text
- **Alignment**: Centered headers, mixed alignment for readability
- **Color Coding**: Intuitive status colors

### KPI Cards

Dashboard includes attractive KPI cards:
```
┌─────────────────────┐
│  📋 Total Scenarios │
│        45           │
└─────────────────────┘
```

### Filters & Navigation

- Auto-filters on all data tables
- Frozen headers for easy scrolling
- Tab color coding for quick navigation
- Worksheet names with emoji icons

---

## PDF Report Details

### Generation Method

PDFs are generated using **Playwright's PDF export**:

1. HTML report is fully rendered in headless Chromium
2. Charts are rendered and animated
3. Page is converted to PDF with print styles
4. Headers/footers are added

### Print Optimization

CSS print styles automatically:
- Hide navigation elements
- Optimize chart sizes
- Add page breaks for sections
- Preserve colors and branding

### Custom PDF Options

For advanced use cases, you can generate custom PDFs programmatically:

```typescript
import { CSPdfReportGenerator } from './reporter/CSPdfReportGenerator';

// Custom PDF with options
await CSPdfReportGenerator.generateCustomPdfReport(
    htmlReportPath,
    outputDir,
    {
        includeCharts: true,
        includeScreenshots: false,
        orientation: 'portrait',  // or 'landscape'
        pageSize: 'A4'            // or 'Letter', 'A3', etc.
    }
);

// Multi-view PDFs (separate files for each view)
await CSPdfReportGenerator.generateMultiViewPdfReport(
    htmlReportPath,
    outputDir
);
```

---

## Report Generation Flow

```
Test Execution Completes
         ↓
HTML Report Generated (always)
         ↓
Check GENERATE_EXCEL_REPORT config
    ├─ true → Generate Excel Report
    └─ false → Skip
         ↓
Check GENERATE_PDF_REPORT config
    ├─ true → Generate PDF Report (from HTML)
    └─ false → Skip
         ↓
All Reports Ready! ✅
```

---

## KPIs Included

Both Excel and PDF reports include:

### Scenario Metrics
- Total Scenarios
- Passed Scenarios
- Failed Scenarios
- Skipped Scenarios
- Pass Rate %

### Step Metrics
- Total Steps
- Passed Steps
- Failed Steps
- Skipped Steps
- Step Pass Rate %

### Performance Metrics
- Total Execution Time
- Average Scenario Duration
- Scenarios per Minute
- Fastest Scenarios
- Slowest Scenarios

### Failure Analysis
- Failure Categories (Timeout, Element Not Found, Assertion, etc.)
- Failure Counts and Percentages
- Detailed Error Messages

### Feature Breakdown
- Tests by Feature
- Feature-level pass/fail/skip counts

### Historical Trends
- Last 100 execution records
- 7-day trend data
- Pass rate trends over time

---

## Technical Implementation

### Excel Generation
- **Library**: ExcelJS v4.4.0
- **Format**: XLSX (Office Open XML)
- **Performance**: ~500ms for typical test suite
- **Memory**: Low memory footprint, streams large datasets

### PDF Generation
- **Engine**: Playwright Chromium
- **Method**: page.pdf() with print styles
- **Quality**: High-quality vector graphics preserved
- **Charts**: Fully rendered and visible
- **Performance**: ~2-3 seconds including browser launch

---

## Troubleshooting

### Excel Report Not Generated

**Check:**
1. `GENERATE_EXCEL_REPORT=true` in config
2. ExcelJS installed: `npm list exceljs`
3. Check logs for errors

### PDF Report Not Generated

**Check:**
1. `GENERATE_PDF_REPORT=true` in config
2. Playwright installed: `npm list playwright`
3. Chromium browser installed: `npx playwright install chromium`
4. HTML report exists (PDF generated from HTML)

### Charts Not Showing in PDF

**Solution:**
- Increase wait time in CSPdfReportGenerator.ts
- Check if HTML charts rendered properly
- Ensure JavaScript enabled in PDF generation

### Excel File Won't Open

**Possible Causes:**
- Incomplete write (check disk space)
- Corrupted data in test results
- Excel version compatibility (use Office 2010+)

---

## Best Practices

1. **Always generate HTML first** - Excel and PDF depend on test data
2. **Keep history clean** - Framework automatically maintains last 100 runs
3. **Archive old reports** - Use timestamp folders to avoid overwriting
4. **Review Excel filters** - Use built-in filters for deep analysis
5. **Share PDF reports** - Best format for stakeholders and documentation
6. **Use Excel for data analysis** - Export charts and create custom pivots

---

## Examples

### Enable All Report Formats
```properties
GENERATE_EXCEL_REPORT=true
GENERATE_PDF_REPORT=true
REPORTS_CREATE_TIMESTAMP_FOLDER=true
```

### HTML Only (Fastest)
```properties
GENERATE_EXCEL_REPORT=false
GENERATE_PDF_REPORT=false
```

### Excel for Analysis, Skip PDF
```properties
GENERATE_EXCEL_REPORT=true
GENERATE_PDF_REPORT=false
```

---

## Version Information

- **Added in**: Version 3.0.20
- **Dependencies**:
  - `exceljs`: ^4.4.0
  - `playwright`: ^1.55.0 (already included)
- **Supported Formats**: XLSX, PDF, HTML
- **Browser Required**: Chromium (auto-installed with Playwright)

---

## Support

For issues or enhancements, please contact the CS Framework team or file an issue in the repository.

**Happy Testing! 🚀**
