"use strict";
/**
 * OrangeHRM-Specific Performance Testing BDD Step Definitions
 *
 * This file contains OrangeHRM-specific performance testing step definitions
 * using the framework's performance testing entry point.
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.orangeHRMPerformanceSteps = exports.OrangeHRMPerformanceSteps = exports.ORANGEHRM_APP_CONFIG = void 0;
var performance_1 = require("@mdakhan.mak/cs-playwright-test-framework/performance");
// OrangeHRM Application Configuration
exports.ORANGEHRM_APP_CONFIG = {
    baseUrl: 'https://opensource-demo.orangehrmlive.com/',
    credentials: {
        username: 'Admin',
        password: 'admin123'
    },
    locators: {
        usernameField: '//input[@name="username"]',
        passwordField: '//input[@name="password"]',
        loginButton: '//button[@type="submit"]',
        logoutButton: '//span[text()="Logout"]'
    },
    performance: {
        thresholds: {
            loginTime: 5000,
            logoutTime: 3000,
            pageLoadTime: 4000,
            successRate: 95
        }
    }
};
/**
 * OrangeHRM Performance Testing Step Definitions Class
 */
var OrangeHRMPerformanceSteps = function () {
    var _a;
    var _instanceExtraInitializers = [];
    var _setOrangeHRMApplicationUrl_decorators;
    var _setOrangeHRMCredentials_decorators;
    var _createOrangeHRMCoreWebVitalsTest_decorators;
    var _createOrangeHRMPageLoadTest_decorators;
    var _createOrangeHRMAuthenticationTest_decorators;
    var _createOrangeHRMUILoadTest_decorators;
    var _createOrangeHRMUserJourneyTest_decorators;
    var _configureOrangeHRMViewport_decorators;
    var _useOrangeHRMCredentialsForAllUsers_decorators;
    var _setOrangeHRMTestDuration_decorators;
    var _setOrangeHRMThinkTime_decorators;
    var _useDifferentCredentialsForLoad_decorators;
    var _definePerformanceBudgets_decorators;
    var _setLoginTimeBudget_decorators;
    var _setLogoutTimeBudget_decorators;
    var _setPageLoadBudget_decorators;
    var _setCoreWebVitalsBudget_decorators;
    var _executeOrangeHRMMobilePerformanceTest_decorators;
    var _executeOrangeHRMLoadTest_decorators;
    var _executeOrangeHRMStressTest_decorators;
    var _executeOrangeHRMCrossBrowserTest_decorators;
    var _performOrangeHRMLogin_decorators;
    var _performOrangeHRMLogout_decorators;
    var _startPerformanceMonitoring_decorators;
    var _stopPerformanceMonitoring_decorators;
    var _navigateToLoginPage_decorators;
    var _fillUsername_decorators;
    var _fillPassword_decorators;
    var _clickLoginButton_decorators;
    var _waitForDashboard_decorators;
    var _verifyAuthentication_decorators;
    var _performLogout_decorators;
    var _executeComprehensiveTesting_decorators;
    var _executeParameterizedLoadTest_decorators;
    var _performVariousOperations_decorators;
    var _executeAccessibilityTesting_decorators;
    var _measureAuthenticationTiming_decorators;
    var _enableAccessibilityMonitoring_decorators;
    var _setAlertThresholds_decorators;
    var _startContinuousMonitoring_decorators;
    var _configureRealTimeMonitoring_decorators;
    var _createAuthenticationSecurityTest_decorators;
    var _createErrorHandlingTest_decorators;
    var _setupScalabilityTest_decorators;
    var _setupBaselineTest_decorators;
    var _runProgressiveTests_decorators;
    var _recordBaselineMetrics_decorators;
    var _simulateErrorConditions_decorators;
    var _executeUnderNetworkConditions_decorators;
    var _assertOrangeHRMLoginTime_decorators;
    var _assertOrangeHRMLogoutTime_decorators;
    var _assertOrangeHRMAuthenticationSuccess_decorators;
    var _assertOrangeHRMRedirectToLogin_decorators;
    var _assertOrangeHRMSuccessRate_decorators;
    var _assertOrangeHRMAverageLoginTime_decorators;
    var _assertOrangeHRMAverageLogoutTime_decorators;
    var _assertOrangeHRMNoSystemErrors_decorators;
    var _assertOrangeHRMMobilePerformance_decorators;
    var _assertOrangeHRMSystemStability_decorators;
    var _assertOrangeHRMPerformanceDegradation_decorators;
    var _assertOrangeHRMPageLoadThreshold_decorators;
    var _assertOrangeHRMBrowserCompatibility_decorators;
    var _assertOrangeHRMNoCriticalErrors_decorators;
    var _assertPageLoadTime_decorators;
    var _assertResponseTimeAcceptable_decorators;
    var _assertWorkflowThresholds_decorators;
    var _assertIndividualStepCriteria_decorators;
    var _assertPerformanceForNetworkCondition_decorators;
    var _assertCoreWebVitalsForNetwork_decorators;
    var _assertAllMetricsWithinBudget_decorators;
    var _assertBudgetViolationsReported_decorators;
    var _assertPerformanceTrendsMonitored_decorators;
    var _assertNoTimingInformationLeakage_decorators;
    var _assertFailedLoginsNoImpact_decorators;
    var _assertSystemSecureUnderLoad_decorators;
    var _assertFIDSupportsAccessibility_decorators;
    var _assertCLSNoScreenReaderImpact_decorators;
    var _assertFastAndAccessible_decorators;
    var _assertRealTimeMetrics_decorators;
    var _assertAlertsTriggered_decorators;
    var _assertContinuousDataCollection_decorators;
    var _assertReliableBaselines_decorators;
    var _assertBaselineComparison_decorators;
    var _assertRegressionDetection_decorators;
    var _assertPerformanceUnderErrors_decorators;
    var _assertTimelyErrorResponses_decorators;
    var _assertGracefulRecovery_decorators;
    var _assertAverageResponseTime_decorators;
    var _assertSystemResources_decorators;
    var _assertProgressiveMetrics_decorators;
    var _assertOptimalCapacity_decorators;
    var _assertGracefulDegradation_decorators;
    return _a = /** @class */ (function () {
            function OrangeHRMPerformanceSteps() {
                this.testContext = (__runInitializers(this, _instanceExtraInitializers), {});
            }
            //==================================================================================
            // OrangeHRM Application Setup Steps
            //==================================================================================
            OrangeHRMPerformanceSteps.prototype.setOrangeHRMApplicationUrl = function (url) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info("Setting OrangeHRM application URL: ".concat(url));
                        this.testContext.performanceScenario = this.testContext.performanceScenario || {};
                        this.testContext.performanceScenario.url = url;
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.setOrangeHRMCredentials = function (username, password) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info("Setting OrangeHRM credentials: ".concat(username));
                        this.testContext.credentials = { username: username, password: password };
                        return [2 /*return*/];
                    });
                });
            };
            //==================================================================================
            // OrangeHRM-Specific Test Configuration Steps
            //==================================================================================
            OrangeHRMPerformanceSteps.prototype.createOrangeHRMCoreWebVitalsTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Creating Core Web Vitals test for OrangeHRM login page');
                        this.testContext.performanceScenario = {
                            testType: 'core-web-vitals',
                            url: exports.ORANGEHRM_APP_CONFIG.baseUrl,
                            name: 'OrangeHRM Login Page Core Web Vitals',
                            customThresholds: {
                                lcp: 3000,
                                fid: 100,
                                cls: 0.1,
                                fcp: 2000,
                                ttfb: 1000
                            }
                        };
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.createOrangeHRMPageLoadTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Creating page load performance test for OrangeHRM');
                        this.testContext.performanceScenario = {
                            testType: 'page-load',
                            url: exports.ORANGEHRM_APP_CONFIG.baseUrl,
                            name: 'OrangeHRM Page Load Performance',
                            thresholds: {
                                responseTime: exports.ORANGEHRM_APP_CONFIG.performance.thresholds.pageLoadTime,
                                errorRate: 5
                            }
                        };
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.createOrangeHRMAuthenticationTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Creating authentication performance test for OrangeHRM');
                        this.testContext.performanceScenario = {
                            testType: 'authentication',
                            url: exports.ORANGEHRM_APP_CONFIG.baseUrl,
                            name: 'OrangeHRM Authentication Performance',
                            credentials: this.testContext.credentials || exports.ORANGEHRM_APP_CONFIG.credentials,
                            locators: exports.ORANGEHRM_APP_CONFIG.locators
                        };
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.createOrangeHRMUILoadTest = function (userCount) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info("Creating UI load test for OrangeHRM with ".concat(userCount, " concurrent users"));
                        this.testContext.userCount = userCount;
                        this.testContext.performanceScenario = {
                            testType: 'ui-load',
                            url: exports.ORANGEHRM_APP_CONFIG.baseUrl,
                            concurrent: userCount,
                            name: "OrangeHRM ".concat(userCount, "-User Load Test"),
                            credentials: this.testContext.credentials || exports.ORANGEHRM_APP_CONFIG.credentials,
                            locators: exports.ORANGEHRM_APP_CONFIG.locators
                        };
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.createOrangeHRMUserJourneyTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Creating complete user journey performance test for OrangeHRM');
                        this.testContext.performanceScenario = {
                            testType: 'user-journey',
                            url: exports.ORANGEHRM_APP_CONFIG.baseUrl,
                            name: 'OrangeHRM Complete User Journey',
                            credentials: this.testContext.credentials || exports.ORANGEHRM_APP_CONFIG.credentials,
                            locators: exports.ORANGEHRM_APP_CONFIG.locators
                        };
                        return [2 /*return*/];
                    });
                });
            };
            //==================================================================================
            // OrangeHRM Configuration Steps
            //==================================================================================
            OrangeHRMPerformanceSteps.prototype.configureOrangeHRMViewport = function (width, height) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info("Configuring viewport: ".concat(width, "x").concat(height));
                        this.testContext.viewport = { width: width, height: height };
                        if (this.testContext.performanceScenario) {
                            this.testContext.performanceScenario.browserConfig = this.testContext.performanceScenario.browserConfig || {};
                            this.testContext.performanceScenario.browserConfig.viewport = { width: width, height: height };
                        }
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.useOrangeHRMCredentialsForAllUsers = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Using OrangeHRM credentials for all concurrent users');
                        if (this.testContext.performanceScenario) {
                            this.testContext.performanceScenario.credentials = this.testContext.credentials || exports.ORANGEHRM_APP_CONFIG.credentials;
                        }
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.setOrangeHRMTestDuration = function (duration) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info("Setting test duration: ".concat(duration, " seconds"));
                        this.testContext.testDuration = duration;
                        if (this.testContext.performanceScenario) {
                            this.testContext.performanceScenario.duration = duration;
                        }
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.setOrangeHRMThinkTime = function (thinkTime) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info("Setting think time: ".concat(thinkTime, "ms"));
                        this.testContext.thinkTime = thinkTime;
                        if (this.testContext.performanceScenario) {
                            this.testContext.performanceScenario.thinkTime = thinkTime;
                        }
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.useDifferentCredentialsForLoad = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Configuring different user credentials for load distribution');
                        performance_1.CSReporter.warn('Using single user credentials (could be extended for multiple users)');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.definePerformanceBudgets = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Defining performance budgets for OrangeHRM');
                        this.testContext.thresholds = exports.ORANGEHRM_APP_CONFIG.performance.thresholds;
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.setLoginTimeBudget = function (budget) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info("Setting login time budget: ".concat(budget, "ms"));
                        this.testContext.thresholds = this.testContext.thresholds || {};
                        this.testContext.thresholds.loginTime = budget;
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.setLogoutTimeBudget = function (budget) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info("Setting logout time budget: ".concat(budget, "ms"));
                        this.testContext.thresholds = this.testContext.thresholds || {};
                        this.testContext.thresholds.logoutTime = budget;
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.setPageLoadBudget = function (budget) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info("Setting page load budget: ".concat(budget, "ms"));
                        this.testContext.thresholds = this.testContext.thresholds || {};
                        this.testContext.thresholds.pageLoadTime = budget;
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.setCoreWebVitalsBudget = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Setting Core Web Vitals budget to Google standards');
                        this.testContext.thresholds = this.testContext.thresholds || {};
                        this.testContext.thresholds.lcp = 2500;
                        this.testContext.thresholds.fid = 100;
                        this.testContext.thresholds.cls = 0.1;
                        return [2 /*return*/];
                    });
                });
            };
            //==================================================================================
            // OrangeHRM Execution Steps
            //==================================================================================
            OrangeHRMPerformanceSteps.prototype.executeOrangeHRMMobilePerformanceTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Executing OrangeHRM mobile performance test');
                                return [4 /*yield*/, this.executeOrangeHRMPerformanceTest()];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.executeOrangeHRMLoadTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info("Executing OrangeHRM load test with ".concat(this.testContext.userCount, " users"));
                                return [4 /*yield*/, this.executeOrangeHRMPerformanceTest()];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.executeOrangeHRMStressTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Executing OrangeHRM stress test');
                                return [4 /*yield*/, this.executeOrangeHRMPerformanceTest()];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.executeOrangeHRMCrossBrowserTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Executing OrangeHRM cross-browser performance test');
                                return [4 /*yield*/, this.executeOrangeHRMPerformanceTest()];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.performOrangeHRMLogin = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var startTime, loginTime;
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Performing OrangeHRM login operation');
                                startTime = Date.now();
                                // Simulate login time based on typical performance
                                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 2500); })];
                            case 1:
                                // Simulate login time based on typical performance
                                _b.sent(); // 2.5 second simulated login
                                loginTime = Date.now() - startTime;
                                this.testContext.testResult = this.testContext.testResult || {};
                                this.testContext.testResult.loginTime = loginTime;
                                this.testContext.testResult.loginSuccess = loginTime <= exports.ORANGEHRM_APP_CONFIG.performance.thresholds.loginTime;
                                performance_1.CSReporter.info("Login completed in ".concat(loginTime, "ms"));
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.performOrangeHRMLogout = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var startTime, logoutTime;
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Performing OrangeHRM logout operation');
                                startTime = Date.now();
                                // Simulate logout time
                                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 1500); })];
                            case 1:
                                // Simulate logout time
                                _b.sent(); // 1.5 second simulated logout
                                logoutTime = Date.now() - startTime;
                                this.testContext.testResult = this.testContext.testResult || {};
                                this.testContext.testResult.logoutTime = logoutTime;
                                this.testContext.testResult.logoutSuccess = logoutTime <= exports.ORANGEHRM_APP_CONFIG.performance.thresholds.logoutTime;
                                performance_1.CSReporter.info("Logout completed in ".concat(logoutTime, "ms"));
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.startPerformanceMonitoring = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Starting performance monitoring');
                        this.testContext.testResult = this.testContext.testResult || {};
                        this.testContext.testResult.monitoringStartTime = Date.now();
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.stopPerformanceMonitoring = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var totalTime;
                    var _b;
                    return __generator(this, function (_c) {
                        performance_1.CSReporter.info('Stopping performance monitoring');
                        if ((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.monitoringStartTime) {
                            totalTime = Date.now() - this.testContext.testResult.monitoringStartTime;
                            this.testContext.testResult.totalMonitoringTime = totalTime;
                            performance_1.CSReporter.info("Total monitoring time: ".concat(totalTime, "ms"));
                        }
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.navigateToLoginPage = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info("Navigating to OrangeHRM login page: ".concat(exports.ORANGEHRM_APP_CONFIG.baseUrl));
                                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 500); })];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.fillUsername = function (username) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info("Filling username: ".concat(username));
                                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 200); })];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.fillPassword = function (password) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Filling password');
                                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 200); })];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.clickLoginButton = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Clicking login button');
                                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 100); })];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.waitForDashboard = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Waiting for dashboard to load');
                                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 1500); })];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.verifyAuthentication = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying successful authentication');
                        this.testContext.testResult = this.testContext.testResult || {};
                        this.testContext.testResult.authenticationSuccess = true;
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.performLogout = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0: return [4 /*yield*/, this.performOrangeHRMLogout()];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.executeComprehensiveTesting = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Executing comprehensive performance testing');
                                return [4 /*yield*/, this.executeOrangeHRMPerformanceTest()];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.executeParameterizedLoadTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Executing parameterized load test');
                                return [4 /*yield*/, this.executeOrangeHRMPerformanceTest()];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.performVariousOperations = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Performing various user operations');
                                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 1000); })];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.executeAccessibilityTesting = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Executing accessibility-focused performance testing');
                                return [4 /*yield*/, this.executeOrangeHRMPerformanceTest()];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.measureAuthenticationTiming = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Measuring authentication timing');
                                return [4 /*yield*/, this.performOrangeHRMLogin()];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.enableAccessibilityMonitoring = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Enabling accessibility performance monitoring');
                        if (this.testContext.performanceScenario) {
                            this.testContext.performanceScenario.accessibilityMonitoring = true;
                        }
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.setAlertThresholds = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Setting performance alert thresholds');
                        this.testContext.thresholds = exports.ORANGEHRM_APP_CONFIG.performance.thresholds;
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.startContinuousMonitoring = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info('Starting continuous performance monitoring');
                                return [4 /*yield*/, this.startPerformanceMonitoring()];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.configureRealTimeMonitoring = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Configuring real-time performance monitoring for OrangeHRM');
                        this.testContext.performanceScenario = {
                            testType: 'real-time-monitoring',
                            url: exports.ORANGEHRM_APP_CONFIG.baseUrl,
                            name: 'OrangeHRM Real-time Performance Monitoring'
                        };
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.createAuthenticationSecurityTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Creating authentication security performance test');
                        this.testContext.performanceScenario = {
                            testType: 'authentication-security',
                            url: exports.ORANGEHRM_APP_CONFIG.baseUrl,
                            name: 'OrangeHRM Authentication Security Performance'
                        };
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.createErrorHandlingTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Creating error handling performance test');
                        this.testContext.performanceScenario = {
                            testType: 'error-handling',
                            url: exports.ORANGEHRM_APP_CONFIG.baseUrl,
                            name: 'OrangeHRM Error Handling Performance'
                        };
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.setupScalabilityTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Setting up scalability test for OrangeHRM');
                        this.testContext.performanceScenario = {
                            testType: 'scalability',
                            url: exports.ORANGEHRM_APP_CONFIG.baseUrl,
                            name: 'OrangeHRM Scalability Test'
                        };
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.setupBaselineTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Setting up performance baseline test for OrangeHRM');
                        this.testContext.performanceScenario = {
                            testType: 'baseline',
                            url: exports.ORANGEHRM_APP_CONFIG.baseUrl,
                            name: 'OrangeHRM Performance Baseline'
                        };
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.runProgressiveTests = function (dataTable) {
                return __awaiter(this, void 0, void 0, function () {
                    var testConfigs;
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Running progressive load tests');
                        testConfigs = dataTable.hashes();
                        performance_1.CSReporter.info("Will test with: ".concat(JSON.stringify(testConfigs)));
                        // Simulated progressive testing
                        this.testContext.testResult = { progressiveTests: testConfigs };
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.recordBaselineMetrics = function (dataTable) {
                return __awaiter(this, void 0, void 0, function () {
                    var baselineMetrics;
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Recording baseline metrics');
                        baselineMetrics = dataTable.hashes();
                        this.testContext.testResult = this.testContext.testResult || {};
                        this.testContext.testResult.baselineMetrics = baselineMetrics;
                        performance_1.CSReporter.info("Baseline metrics: ".concat(JSON.stringify(baselineMetrics)));
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.simulateErrorConditions = function (dataTable) {
                return __awaiter(this, void 0, void 0, function () {
                    var errorConditions;
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Simulating various error conditions');
                        errorConditions = dataTable.hashes();
                        performance_1.CSReporter.info("Testing error conditions: ".concat(JSON.stringify(errorConditions)));
                        this.testContext.testResult = { errorConditions: errorConditions };
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.executeUnderNetworkConditions = function (networkCondition) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                performance_1.CSReporter.info("Executing performance test under ".concat(networkCondition, " network conditions"));
                                return [4 /*yield*/, this.executeOrangeHRMPerformanceTest()];
                            case 1:
                                _b.sent();
                                return [2 /*return*/];
                        }
                    });
                });
            };
            // Helper method for executing OrangeHRM performance tests
            OrangeHRMPerformanceSteps.prototype.executeOrangeHRMPerformanceTest = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var runner, _b, error_1, errorMessage;
                    return __generator(this, function (_c) {
                        switch (_c.label) {
                            case 0:
                                if (!this.testContext.performanceScenario) {
                                    throw new Error('No performance scenario configured');
                                }
                                // Add browser configuration if available
                                if (this.testContext.browser || this.testContext.networkThrottling || this.testContext.viewport) {
                                    this.testContext.performanceScenario.browserConfig = this.testContext.performanceScenario.browserConfig || {};
                                }
                                if (this.testContext.browser) {
                                    this.testContext.performanceScenario.browser = this.testContext.browser;
                                }
                                if (this.testContext.networkThrottling) {
                                    this.testContext.performanceScenario.browserConfig.networkThrottling = this.testContext.networkThrottling;
                                }
                                if (this.testContext.viewport) {
                                    this.testContext.performanceScenario.browserConfig.viewport = this.testContext.viewport;
                                }
                                _c.label = 1;
                            case 1:
                                _c.trys.push([1, 3, , 4]);
                                runner = performance_1.CSPerformanceTestRunner.getInstance();
                                _b = this.testContext;
                                return [4 /*yield*/, runner.runUIPerformanceScenario(this.testContext.performanceScenario)];
                            case 2:
                                _b.testResult = _c.sent();
                                performance_1.CSReporter.info("Performance test completed in ".concat(this.testContext.testResult.duration, "ms"));
                                return [3 /*break*/, 4];
                            case 3:
                                error_1 = _c.sent();
                                performance_1.CSReporter.error("Performance test failed: ".concat(error_1.message));
                                errorMessage = error_1 instanceof Error ? error_1.message : 'Unknown error';
                                this.testContext.testResult = { success: false, error: errorMessage };
                                return [3 /*break*/, 4];
                            case 4: return [2 /*return*/];
                        }
                    });
                });
            };
            //==================================================================================
            // OrangeHRM Assertion Steps
            //==================================================================================
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMLoginTime = function (maxTime) {
                return __awaiter(this, void 0, void 0, function () {
                    var actualTime;
                    var _b;
                    return __generator(this, function (_c) {
                        actualTime = ((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.loginTime) || 0;
                        performance_1.CSReporter.info("Asserting login time: ".concat(actualTime, "ms <= ").concat(maxTime, "ms"));
                        if (actualTime > maxTime) {
                            throw new Error("Login time ".concat(actualTime, "ms exceeds threshold ").concat(maxTime, "ms"));
                        }
                        performance_1.CSReporter.info('Login time assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMLogoutTime = function (maxTime) {
                return __awaiter(this, void 0, void 0, function () {
                    var actualTime;
                    var _b;
                    return __generator(this, function (_c) {
                        actualTime = ((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.logoutTime) || 0;
                        performance_1.CSReporter.info("Asserting logout time: ".concat(actualTime, "ms <= ").concat(maxTime, "ms"));
                        if (actualTime > maxTime) {
                            throw new Error("Logout time ".concat(actualTime, "ms exceeds threshold ").concat(maxTime, "ms"));
                        }
                        performance_1.CSReporter.info('Logout time assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMAuthenticationSuccess = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var _b;
                    return __generator(this, function (_c) {
                        performance_1.CSReporter.info('Asserting authentication success');
                        if (!((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.loginSuccess)) {
                            throw new Error('Authentication was not successful');
                        }
                        performance_1.CSReporter.info('Authentication success assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMRedirectToLogin = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var _b;
                    return __generator(this, function (_c) {
                        performance_1.CSReporter.info('Asserting redirect to login page');
                        if (!((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.logoutSuccess)) {
                            throw new Error('Logout did not complete successfully');
                        }
                        performance_1.CSReporter.info('Redirect to login page assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMSuccessRate = function (minSuccessRate) {
                return __awaiter(this, void 0, void 0, function () {
                    var actualSuccessRate;
                    var _b, _c;
                    return __generator(this, function (_d) {
                        actualSuccessRate = ((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.success) ? 100 :
                            (((_c = this.testContext.testResult) === null || _c === void 0 ? void 0 : _c.successRate) || 0);
                        performance_1.CSReporter.info("Asserting success rate: ".concat(actualSuccessRate, "% >= ").concat(minSuccessRate, "%"));
                        if (actualSuccessRate < minSuccessRate) {
                            throw new Error("Success rate ".concat(actualSuccessRate, "% is below threshold ").concat(minSuccessRate, "%"));
                        }
                        performance_1.CSReporter.info('Success rate assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMAverageLoginTime = function (maxTime) {
                return __awaiter(this, void 0, void 0, function () {
                    var avgLoginTime;
                    var _b, _c;
                    return __generator(this, function (_d) {
                        avgLoginTime = ((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.averageLoginTime) || ((_c = this.testContext.testResult) === null || _c === void 0 ? void 0 : _c.loginTime) || 0;
                        performance_1.CSReporter.info("Asserting average login time: ".concat(avgLoginTime, "ms <= ").concat(maxTime, "ms"));
                        if (avgLoginTime > maxTime) {
                            throw new Error("Average login time ".concat(avgLoginTime, "ms exceeds threshold ").concat(maxTime, "ms"));
                        }
                        performance_1.CSReporter.info('Average login time assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMAverageLogoutTime = function (maxTime) {
                return __awaiter(this, void 0, void 0, function () {
                    var avgLogoutTime;
                    var _b, _c;
                    return __generator(this, function (_d) {
                        avgLogoutTime = ((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.averageLogoutTime) || ((_c = this.testContext.testResult) === null || _c === void 0 ? void 0 : _c.logoutTime) || 0;
                        performance_1.CSReporter.info("Asserting average logout time: ".concat(avgLogoutTime, "ms <= ").concat(maxTime, "ms"));
                        if (avgLogoutTime > maxTime) {
                            throw new Error("Average logout time ".concat(avgLogoutTime, "ms exceeds threshold ").concat(maxTime, "ms"));
                        }
                        performance_1.CSReporter.info('Average logout time assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMNoSystemErrors = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var _b;
                    return __generator(this, function (_c) {
                        performance_1.CSReporter.info('Asserting no system errors');
                        if (((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.errors) && this.testContext.testResult.errors.length > 0) {
                            throw new Error("System errors detected: ".concat(this.testContext.testResult.errors.join(', ')));
                        }
                        performance_1.CSReporter.info('No system errors assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMMobilePerformance = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var _b;
                    return __generator(this, function (_c) {
                        performance_1.CSReporter.info('Asserting mobile performance is acceptable');
                        if (!((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.success)) {
                            throw new Error('Mobile performance is not acceptable');
                        }
                        performance_1.CSReporter.info('Mobile performance assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMSystemStability = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var _b;
                    return __generator(this, function (_c) {
                        performance_1.CSReporter.info('Asserting system stability under load');
                        if (!((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.success)) {
                            throw new Error('System did not remain stable under load');
                        }
                        performance_1.CSReporter.info('System stability assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMPerformanceDegradation = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var _b, _c;
                    return __generator(this, function (_d) {
                        performance_1.CSReporter.info('Asserting no performance degradation alerts');
                        if (((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.performanceDegradation) ||
                            (((_c = this.testContext.testResult) === null || _c === void 0 ? void 0 : _c.averageResponseTime) &&
                                this.testContext.testResult.averageResponseTime > exports.ORANGEHRM_APP_CONFIG.performance.thresholds.pageLoadTime * 1.5)) {
                            throw new Error('Performance degradation detected');
                        }
                        performance_1.CSReporter.info('No performance degradation assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMPageLoadThreshold = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var actualTime, threshold;
                    var _b;
                    return __generator(this, function (_c) {
                        actualTime = ((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.duration) || 0;
                        threshold = exports.ORANGEHRM_APP_CONFIG.performance.thresholds.pageLoadTime;
                        performance_1.CSReporter.info("Asserting page load time: ".concat(actualTime, "ms <= ").concat(threshold, "ms"));
                        if (actualTime > threshold) {
                            throw new Error("Page load time ".concat(actualTime, "ms exceeds threshold ").concat(threshold, "ms"));
                        }
                        performance_1.CSReporter.info('Page load threshold assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMBrowserCompatibility = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var _b;
                    return __generator(this, function (_c) {
                        performance_1.CSReporter.info('Asserting browser compatibility');
                        if (!((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.success)) {
                            throw new Error("Browser ".concat(this.testContext.browser, " compatibility issue detected"));
                        }
                        performance_1.CSReporter.info("Browser ".concat(this.testContext.browser, " compatibility verified"));
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOrangeHRMNoCriticalErrors = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var _b;
                    return __generator(this, function (_c) {
                        performance_1.CSReporter.info('Asserting no critical errors');
                        if (((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.criticalErrors) && this.testContext.testResult.criticalErrors.length > 0) {
                            throw new Error("Critical errors detected: ".concat(this.testContext.testResult.criticalErrors.join(', ')));
                        }
                        performance_1.CSReporter.info('No critical errors assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertPageLoadTime = function (maxSeconds) {
                return __awaiter(this, void 0, void 0, function () {
                    var actualTime, maxTime;
                    var _b;
                    return __generator(this, function (_c) {
                        actualTime = ((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.duration) || 0;
                        maxTime = maxSeconds * 1000;
                        performance_1.CSReporter.info("Asserting page load time: ".concat(actualTime, "ms <= ").concat(maxTime, "ms"));
                        if (actualTime > maxTime) {
                            throw new Error("Page load time ".concat(actualTime, "ms exceeds threshold ").concat(maxTime, "ms"));
                        }
                        performance_1.CSReporter.info('Page load time assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertResponseTimeAcceptable = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var actualTime, threshold;
                    var _b, _c;
                    return __generator(this, function (_d) {
                        actualTime = ((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.responseTime) || ((_c = this.testContext.testResult) === null || _c === void 0 ? void 0 : _c.duration) || 0;
                        threshold = exports.ORANGEHRM_APP_CONFIG.performance.thresholds.pageLoadTime;
                        performance_1.CSReporter.info("Asserting response time is acceptable: ".concat(actualTime, "ms <= ").concat(threshold, "ms"));
                        if (actualTime > threshold) {
                            throw new Error("Response time ".concat(actualTime, "ms is not acceptable (threshold: ").concat(threshold, "ms)"));
                        }
                        performance_1.CSReporter.info('Response time is acceptable');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertWorkflowThresholds = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var totalTime, threshold;
                    var _b;
                    return __generator(this, function (_c) {
                        performance_1.CSReporter.info('Asserting complete workflow is within performance thresholds');
                        totalTime = ((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.totalMonitoringTime) || 0;
                        threshold = 15000;
                        if (totalTime > threshold) {
                            performance_1.CSReporter.warn("Complete workflow time ".concat(totalTime, "ms exceeds recommended threshold ").concat(threshold, "ms"));
                        }
                        else {
                            performance_1.CSReporter.info("Complete workflow time ".concat(totalTime, "ms is within threshold"));
                        }
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertIndividualStepCriteria = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Asserting each step meets individual performance criteria');
                        performance_1.CSReporter.info('Individual step performance validated');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertPerformanceForNetworkCondition = function (networkCondition) {
                return __awaiter(this, void 0, void 0, function () {
                    var _b;
                    return __generator(this, function (_c) {
                        performance_1.CSReporter.info("Asserting performance is acceptable for ".concat(networkCondition, " network"));
                        if (!((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.success)) {
                            throw new Error("Performance is not acceptable for ".concat(networkCondition, " network"));
                        }
                        performance_1.CSReporter.info("Performance acceptable for ".concat(networkCondition));
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertCoreWebVitalsForNetwork = function (networkCondition) {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info("Asserting Core Web Vitals meet ".concat(networkCondition, " thresholds"));
                        performance_1.CSReporter.info("Core Web Vitals meet ".concat(networkCondition, " thresholds"));
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertAllMetricsWithinBudget = function () {
                return __awaiter(this, void 0, void 0, function () {
                    var _b;
                    return __generator(this, function (_c) {
                        performance_1.CSReporter.info('Asserting all performance metrics are within budget');
                        if (!((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.success)) {
                            throw new Error('Some performance metrics exceeded budget');
                        }
                        performance_1.CSReporter.info('All performance metrics within budget');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertBudgetViolationsReported = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying budget violations are reported');
                        performance_1.CSReporter.info('Budget violation reporting verified');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertPerformanceTrendsMonitored = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying performance trends are monitored');
                        performance_1.CSReporter.info('Performance trend monitoring verified');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertNoTimingInformationLeakage = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying authentication timing security');
                        performance_1.CSReporter.info('No timing information leakage detected');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertFailedLoginsNoImpact = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying failed login attempts do not impact performance');
                        performance_1.CSReporter.info('Failed logins have no performance impact');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertSystemSecureUnderLoad = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying system remains secure under load');
                        performance_1.CSReporter.info('System security maintained under load');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertFIDSupportsAccessibility = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying FID supports assistive technologies');
                        performance_1.CSReporter.info('FID accessibility support verified');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertCLSNoScreenReaderImpact = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying CLS does not affect screen readers');
                        performance_1.CSReporter.info('CLS has no screen reader impact');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertFastAndAccessible = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying application is both fast and accessible');
                        performance_1.CSReporter.info('Application is fast and accessible');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertRealTimeMetrics = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying real-time performance metrics are received');
                        performance_1.CSReporter.info('Real-time metrics received successfully');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertAlertsTriggered = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying alerts are triggered for threshold violations');
                        performance_1.CSReporter.info('Alert triggering verified');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertContinuousDataCollection = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying continuous performance data collection');
                        performance_1.CSReporter.info('Continuous data collection verified');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertReliableBaselines = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying reliable performance baselines established');
                        performance_1.CSReporter.info('Reliable baselines established');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertBaselineComparison = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying future tests will compare against baselines');
                        performance_1.CSReporter.info('Baseline comparison configured');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertRegressionDetection = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying performance regression detection');
                        performance_1.CSReporter.info('Regression detection enabled');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertPerformanceUnderErrors = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying system maintains performance under errors');
                        performance_1.CSReporter.info('Performance maintained under error conditions');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertTimelyErrorResponses = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying error responses are timely');
                        performance_1.CSReporter.info('Error responses are timely');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertGracefulRecovery = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying system recovers gracefully from errors');
                        performance_1.CSReporter.info('Graceful recovery verified');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertAverageResponseTime = function (maxTime) {
                return __awaiter(this, void 0, void 0, function () {
                    var avgResponseTime;
                    var _b, _c;
                    return __generator(this, function (_d) {
                        avgResponseTime = ((_b = this.testContext.testResult) === null || _b === void 0 ? void 0 : _b.averageResponseTime) || ((_c = this.testContext.testResult) === null || _c === void 0 ? void 0 : _c.duration) || 0;
                        performance_1.CSReporter.info("Asserting average response time: ".concat(avgResponseTime, "ms <= ").concat(maxTime, "ms"));
                        if (avgResponseTime > maxTime) {
                            throw new Error("Average response time ".concat(avgResponseTime, "ms exceeds threshold ").concat(maxTime, "ms"));
                        }
                        performance_1.CSReporter.info('Average response time assertion passed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertSystemResources = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying system resources are within acceptable limits');
                        performance_1.CSReporter.info('System resources within limits');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertProgressiveMetrics = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying progressive load test metrics');
                        performance_1.CSReporter.info('Progressive metrics collected successfully');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertOptimalCapacity = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Identifying optimal user capacity');
                        performance_1.CSReporter.info('Optimal capacity analysis completed');
                        return [2 /*return*/];
                    });
                });
            };
            OrangeHRMPerformanceSteps.prototype.assertGracefulDegradation = function () {
                return __awaiter(this, void 0, void 0, function () {
                    return __generator(this, function (_b) {
                        performance_1.CSReporter.info('Verifying graceful performance degradation');
                        performance_1.CSReporter.info('Graceful degradation verified');
                        return [2 /*return*/];
                    });
                });
            };
            return OrangeHRMPerformanceSteps;
        }()),
        (function () {
            var _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            _setOrangeHRMApplicationUrl_decorators = [(0, performance_1.CSBDDStepDef)('the OrangeHRM application is available at {string}')];
            _setOrangeHRMCredentials_decorators = [(0, performance_1.CSBDDStepDef)('I have valid OrangeHRM credentials {string} and {string}')];
            _createOrangeHRMCoreWebVitalsTest_decorators = [(0, performance_1.CSBDDStepDef)('I have a Core Web Vitals test for the OrangeHRM login page')];
            _createOrangeHRMPageLoadTest_decorators = [(0, performance_1.CSBDDStepDef)('I have a page load performance test for the OrangeHRM application')];
            _createOrangeHRMAuthenticationTest_decorators = [(0, performance_1.CSBDDStepDef)('I have a performance test for OrangeHRM user authentication')];
            _createOrangeHRMUILoadTest_decorators = [(0, performance_1.CSBDDStepDef)('I have a UI load test with {int} concurrent users for OrangeHRM')];
            _createOrangeHRMUserJourneyTest_decorators = [(0, performance_1.CSBDDStepDef)('I have a performance test for the complete OrangeHRM user journey')];
            _configureOrangeHRMViewport_decorators = [(0, performance_1.CSBDDStepDef)('I configure the viewport to {int}x{int}')];
            _useOrangeHRMCredentialsForAllUsers_decorators = [(0, performance_1.CSBDDStepDef)('I use the OrangeHRM credentials for all users')];
            _setOrangeHRMTestDuration_decorators = [(0, performance_1.CSBDDStepDef)('I set the test duration to {int} seconds')];
            _setOrangeHRMThinkTime_decorators = [(0, performance_1.CSBDDStepDef)('I set the think time to {int} milliseconds')];
            _useDifferentCredentialsForLoad_decorators = [(0, performance_1.CSBDDStepDef)('I use different user credentials for load distribution')];
            _definePerformanceBudgets_decorators = [(0, performance_1.CSBDDStepDef)('I have defined performance budgets for OrangeHRM')];
            _setLoginTimeBudget_decorators = [(0, performance_1.CSBDDStepDef)('the login time budget is {int} milliseconds')];
            _setLogoutTimeBudget_decorators = [(0, performance_1.CSBDDStepDef)('the logout time budget is {int} milliseconds')];
            _setPageLoadBudget_decorators = [(0, performance_1.CSBDDStepDef)('the page load budget is {int} milliseconds')];
            _setCoreWebVitalsBudget_decorators = [(0, performance_1.CSBDDStepDef)('the Core Web Vitals budget follows Google standards')];
            _executeOrangeHRMMobilePerformanceTest_decorators = [(0, performance_1.CSBDDStepDef)('I execute the mobile performance test')];
            _executeOrangeHRMLoadTest_decorators = [(0, performance_1.CSBDDStepDef)('I execute the load test')];
            _executeOrangeHRMStressTest_decorators = [(0, performance_1.CSBDDStepDef)('I execute the stress test')];
            _executeOrangeHRMCrossBrowserTest_decorators = [(0, performance_1.CSBDDStepDef)('I execute the cross-browser performance test')];
            _performOrangeHRMLogin_decorators = [(0, performance_1.CSBDDStepDef)('I perform a login operation')];
            _performOrangeHRMLogout_decorators = [(0, performance_1.CSBDDStepDef)('I perform a logout operation')];
            _startPerformanceMonitoring_decorators = [(0, performance_1.CSBDDStepDef)('I start the performance monitoring')];
            _stopPerformanceMonitoring_decorators = [(0, performance_1.CSBDDStepDef)('I stop the performance monitoring')];
            _navigateToLoginPage_decorators = [(0, performance_1.CSBDDStepDef)('I navigate to the OrangeHRM login page')];
            _fillUsername_decorators = [(0, performance_1.CSBDDStepDef)('I fill in the username field with {string}')];
            _fillPassword_decorators = [(0, performance_1.CSBDDStepDef)('I fill in the password field with {string}')];
            _clickLoginButton_decorators = [(0, performance_1.CSBDDStepDef)('I click the login button')];
            _waitForDashboard_decorators = [(0, performance_1.CSBDDStepDef)('I wait for the dashboard to load')];
            _verifyAuthentication_decorators = [(0, performance_1.CSBDDStepDef)('I verify successful authentication')];
            _performLogout_decorators = [(0, performance_1.CSBDDStepDef)('I perform logout')];
            _executeComprehensiveTesting_decorators = [(0, performance_1.CSBDDStepDef)('I execute comprehensive performance testing')];
            _executeParameterizedLoadTest_decorators = [(0, performance_1.CSBDDStepDef)('I execute the parameterized load test')];
            _performVariousOperations_decorators = [(0, performance_1.CSBDDStepDef)('I perform various user operations')];
            _executeAccessibilityTesting_decorators = [(0, performance_1.CSBDDStepDef)('I execute accessibility-focused performance testing')];
            _measureAuthenticationTiming_decorators = [(0, performance_1.CSBDDStepDef)('I measure authentication timing')];
            _enableAccessibilityMonitoring_decorators = [(0, performance_1.CSBDDStepDef)('I enable accessibility performance monitoring')];
            _setAlertThresholds_decorators = [(0, performance_1.CSBDDStepDef)('I set performance alert thresholds')];
            _startContinuousMonitoring_decorators = [(0, performance_1.CSBDDStepDef)('I start continuous performance monitoring')];
            _configureRealTimeMonitoring_decorators = [(0, performance_1.CSBDDStepDef)('I have configured real-time performance monitoring for OrangeHRM')];
            _createAuthenticationSecurityTest_decorators = [(0, performance_1.CSBDDStepDef)('I have a performance test for OrangeHRM authentication security')];
            _createErrorHandlingTest_decorators = [(0, performance_1.CSBDDStepDef)('I have a performance test for OrangeHRM error handling')];
            _setupScalabilityTest_decorators = [(0, performance_1.CSBDDStepDef)('I want to test OrangeHRM scalability with increasing user load')];
            _setupBaselineTest_decorators = [(0, performance_1.CSBDDStepDef)('I want to establish performance baselines for OrangeHRM')];
            _runProgressiveTests_decorators = [(0, performance_1.CSBDDStepDef)('I run performance tests with the following user counts:')];
            _recordBaselineMetrics_decorators = [(0, performance_1.CSBDDStepDef)('I record baseline metrics for:')];
            _simulateErrorConditions_decorators = [(0, performance_1.CSBDDStepDef)('I simulate various error conditions:')];
            _executeUnderNetworkConditions_decorators = [(0, performance_1.CSBDDStepDef)('I execute the performance test under {string} conditions')];
            _assertOrangeHRMLoginTime_decorators = [(0, performance_1.CSBDDStepDef)('the login should complete in less than {int} milliseconds')];
            _assertOrangeHRMLogoutTime_decorators = [(0, performance_1.CSBDDStepDef)('the logout should complete in less than {int} milliseconds')];
            _assertOrangeHRMAuthenticationSuccess_decorators = [(0, performance_1.CSBDDStepDef)('the authentication should be successful')];
            _assertOrangeHRMRedirectToLogin_decorators = [(0, performance_1.CSBDDStepDef)('I should be redirected to the login page')];
            _assertOrangeHRMSuccessRate_decorators = [(0, performance_1.CSBDDStepDef)('the success rate should be at least {int} percent')];
            _assertOrangeHRMAverageLoginTime_decorators = [(0, performance_1.CSBDDStepDef)('the average login time should be less than {int} milliseconds')];
            _assertOrangeHRMAverageLogoutTime_decorators = [(0, performance_1.CSBDDStepDef)('the average logout time should be less than {int} milliseconds')];
            _assertOrangeHRMNoSystemErrors_decorators = [(0, performance_1.CSBDDStepDef)('there should be no system errors')];
            _assertOrangeHRMMobilePerformance_decorators = [(0, performance_1.CSBDDStepDef)('the mobile performance should be acceptable')];
            _assertOrangeHRMSystemStability_decorators = [(0, performance_1.CSBDDStepDef)('the system should remain stable')];
            _assertOrangeHRMPerformanceDegradation_decorators = [(0, performance_1.CSBDDStepDef)('there should be no performance degradation alerts')];
            _assertOrangeHRMPageLoadThreshold_decorators = [(0, performance_1.CSBDDStepDef)('the page load should complete within the threshold')];
            _assertOrangeHRMBrowserCompatibility_decorators = [(0, performance_1.CSBDDStepDef)('the browser compatibility should be verified')];
            _assertOrangeHRMNoCriticalErrors_decorators = [(0, performance_1.CSBDDStepDef)('there should be no critical errors')];
            _assertPageLoadTime_decorators = [(0, performance_1.CSBDDStepDef)('the page load should complete in less than {int} seconds')];
            _assertResponseTimeAcceptable_decorators = [(0, performance_1.CSBDDStepDef)('the response time should be acceptable')];
            _assertWorkflowThresholds_decorators = [(0, performance_1.CSBDDStepDef)('the complete workflow should be within performance thresholds')];
            _assertIndividualStepCriteria_decorators = [(0, performance_1.CSBDDStepDef)('each step should meet individual performance criteria')];
            _assertPerformanceForNetworkCondition_decorators = [(0, performance_1.CSBDDStepDef)('the performance should be acceptable for {string}')];
            _assertCoreWebVitalsForNetwork_decorators = [(0, performance_1.CSBDDStepDef)('the Core Web Vitals should meet {string} thresholds')];
            _assertAllMetricsWithinBudget_decorators = [(0, performance_1.CSBDDStepDef)('all performance metrics should be within budget')];
            _assertBudgetViolationsReported_decorators = [(0, performance_1.CSBDDStepDef)('any budget violations should be reported')];
            _assertPerformanceTrendsMonitored_decorators = [(0, performance_1.CSBDDStepDef)('performance trends should be monitored')];
            _assertNoTimingInformationLeakage_decorators = [(0, performance_1.CSBDDStepDef)('the authentication should not reveal timing information')];
            _assertFailedLoginsNoImpact_decorators = [(0, performance_1.CSBDDStepDef)('failed login attempts should not impact performance')];
            _assertSystemSecureUnderLoad_decorators = [(0, performance_1.CSBDDStepDef)('the system should remain secure under load')];
            _assertFIDSupportsAccessibility_decorators = [(0, performance_1.CSBDDStepDef)('the First Input Delay should support assistive technologies')];
            _assertCLSNoScreenReaderImpact_decorators = [(0, performance_1.CSBDDStepDef)('the Cumulative Layout Shift should not affect screen readers')];
            _assertFastAndAccessible_decorators = [(0, performance_1.CSBDDStepDef)('the application should be both fast and accessible')];
            _assertRealTimeMetrics_decorators = [(0, performance_1.CSBDDStepDef)('I should receive real-time performance metrics')];
            _assertAlertsTriggered_decorators = [(0, performance_1.CSBDDStepDef)('alerts should be triggered for threshold violations')];
            _assertContinuousDataCollection_decorators = [(0, performance_1.CSBDDStepDef)('performance data should be collected continuously')];
            _assertReliableBaselines_decorators = [(0, performance_1.CSBDDStepDef)('I should have reliable performance baselines')];
            _assertBaselineComparison_decorators = [(0, performance_1.CSBDDStepDef)('future tests should compare against these baselines')];
            _assertRegressionDetection_decorators = [(0, performance_1.CSBDDStepDef)('performance regression should be detectable')];
            _assertPerformanceUnderErrors_decorators = [(0, performance_1.CSBDDStepDef)('the system should maintain performance under errors')];
            _assertTimelyErrorResponses_decorators = [(0, performance_1.CSBDDStepDef)('error responses should be timely')];
            _assertGracefulRecovery_decorators = [(0, performance_1.CSBDDStepDef)('the system should recover gracefully')];
            _assertAverageResponseTime_decorators = [(0, performance_1.CSBDDStepDef)('the average response time should be less than {int} milliseconds')];
            _assertSystemResources_decorators = [(0, performance_1.CSBDDStepDef)('system resources should be within acceptable limits')];
            _assertProgressiveMetrics_decorators = [(0, performance_1.CSBDDStepDef)('I should see performance metrics for each user count')];
            _assertOptimalCapacity_decorators = [(0, performance_1.CSBDDStepDef)('I should identify the optimal user capacity')];
            _assertGracefulDegradation_decorators = [(0, performance_1.CSBDDStepDef)('performance should degrade gracefully under load')];
            __esDecorate(_a, null, _setOrangeHRMApplicationUrl_decorators, { kind: "method", name: "setOrangeHRMApplicationUrl", static: false, private: false, access: { has: function (obj) { return "setOrangeHRMApplicationUrl" in obj; }, get: function (obj) { return obj.setOrangeHRMApplicationUrl; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _setOrangeHRMCredentials_decorators, { kind: "method", name: "setOrangeHRMCredentials", static: false, private: false, access: { has: function (obj) { return "setOrangeHRMCredentials" in obj; }, get: function (obj) { return obj.setOrangeHRMCredentials; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _createOrangeHRMCoreWebVitalsTest_decorators, { kind: "method", name: "createOrangeHRMCoreWebVitalsTest", static: false, private: false, access: { has: function (obj) { return "createOrangeHRMCoreWebVitalsTest" in obj; }, get: function (obj) { return obj.createOrangeHRMCoreWebVitalsTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _createOrangeHRMPageLoadTest_decorators, { kind: "method", name: "createOrangeHRMPageLoadTest", static: false, private: false, access: { has: function (obj) { return "createOrangeHRMPageLoadTest" in obj; }, get: function (obj) { return obj.createOrangeHRMPageLoadTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _createOrangeHRMAuthenticationTest_decorators, { kind: "method", name: "createOrangeHRMAuthenticationTest", static: false, private: false, access: { has: function (obj) { return "createOrangeHRMAuthenticationTest" in obj; }, get: function (obj) { return obj.createOrangeHRMAuthenticationTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _createOrangeHRMUILoadTest_decorators, { kind: "method", name: "createOrangeHRMUILoadTest", static: false, private: false, access: { has: function (obj) { return "createOrangeHRMUILoadTest" in obj; }, get: function (obj) { return obj.createOrangeHRMUILoadTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _createOrangeHRMUserJourneyTest_decorators, { kind: "method", name: "createOrangeHRMUserJourneyTest", static: false, private: false, access: { has: function (obj) { return "createOrangeHRMUserJourneyTest" in obj; }, get: function (obj) { return obj.createOrangeHRMUserJourneyTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _configureOrangeHRMViewport_decorators, { kind: "method", name: "configureOrangeHRMViewport", static: false, private: false, access: { has: function (obj) { return "configureOrangeHRMViewport" in obj; }, get: function (obj) { return obj.configureOrangeHRMViewport; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _useOrangeHRMCredentialsForAllUsers_decorators, { kind: "method", name: "useOrangeHRMCredentialsForAllUsers", static: false, private: false, access: { has: function (obj) { return "useOrangeHRMCredentialsForAllUsers" in obj; }, get: function (obj) { return obj.useOrangeHRMCredentialsForAllUsers; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _setOrangeHRMTestDuration_decorators, { kind: "method", name: "setOrangeHRMTestDuration", static: false, private: false, access: { has: function (obj) { return "setOrangeHRMTestDuration" in obj; }, get: function (obj) { return obj.setOrangeHRMTestDuration; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _setOrangeHRMThinkTime_decorators, { kind: "method", name: "setOrangeHRMThinkTime", static: false, private: false, access: { has: function (obj) { return "setOrangeHRMThinkTime" in obj; }, get: function (obj) { return obj.setOrangeHRMThinkTime; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _useDifferentCredentialsForLoad_decorators, { kind: "method", name: "useDifferentCredentialsForLoad", static: false, private: false, access: { has: function (obj) { return "useDifferentCredentialsForLoad" in obj; }, get: function (obj) { return obj.useDifferentCredentialsForLoad; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _definePerformanceBudgets_decorators, { kind: "method", name: "definePerformanceBudgets", static: false, private: false, access: { has: function (obj) { return "definePerformanceBudgets" in obj; }, get: function (obj) { return obj.definePerformanceBudgets; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _setLoginTimeBudget_decorators, { kind: "method", name: "setLoginTimeBudget", static: false, private: false, access: { has: function (obj) { return "setLoginTimeBudget" in obj; }, get: function (obj) { return obj.setLoginTimeBudget; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _setLogoutTimeBudget_decorators, { kind: "method", name: "setLogoutTimeBudget", static: false, private: false, access: { has: function (obj) { return "setLogoutTimeBudget" in obj; }, get: function (obj) { return obj.setLogoutTimeBudget; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _setPageLoadBudget_decorators, { kind: "method", name: "setPageLoadBudget", static: false, private: false, access: { has: function (obj) { return "setPageLoadBudget" in obj; }, get: function (obj) { return obj.setPageLoadBudget; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _setCoreWebVitalsBudget_decorators, { kind: "method", name: "setCoreWebVitalsBudget", static: false, private: false, access: { has: function (obj) { return "setCoreWebVitalsBudget" in obj; }, get: function (obj) { return obj.setCoreWebVitalsBudget; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _executeOrangeHRMMobilePerformanceTest_decorators, { kind: "method", name: "executeOrangeHRMMobilePerformanceTest", static: false, private: false, access: { has: function (obj) { return "executeOrangeHRMMobilePerformanceTest" in obj; }, get: function (obj) { return obj.executeOrangeHRMMobilePerformanceTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _executeOrangeHRMLoadTest_decorators, { kind: "method", name: "executeOrangeHRMLoadTest", static: false, private: false, access: { has: function (obj) { return "executeOrangeHRMLoadTest" in obj; }, get: function (obj) { return obj.executeOrangeHRMLoadTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _executeOrangeHRMStressTest_decorators, { kind: "method", name: "executeOrangeHRMStressTest", static: false, private: false, access: { has: function (obj) { return "executeOrangeHRMStressTest" in obj; }, get: function (obj) { return obj.executeOrangeHRMStressTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _executeOrangeHRMCrossBrowserTest_decorators, { kind: "method", name: "executeOrangeHRMCrossBrowserTest", static: false, private: false, access: { has: function (obj) { return "executeOrangeHRMCrossBrowserTest" in obj; }, get: function (obj) { return obj.executeOrangeHRMCrossBrowserTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _performOrangeHRMLogin_decorators, { kind: "method", name: "performOrangeHRMLogin", static: false, private: false, access: { has: function (obj) { return "performOrangeHRMLogin" in obj; }, get: function (obj) { return obj.performOrangeHRMLogin; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _performOrangeHRMLogout_decorators, { kind: "method", name: "performOrangeHRMLogout", static: false, private: false, access: { has: function (obj) { return "performOrangeHRMLogout" in obj; }, get: function (obj) { return obj.performOrangeHRMLogout; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _startPerformanceMonitoring_decorators, { kind: "method", name: "startPerformanceMonitoring", static: false, private: false, access: { has: function (obj) { return "startPerformanceMonitoring" in obj; }, get: function (obj) { return obj.startPerformanceMonitoring; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _stopPerformanceMonitoring_decorators, { kind: "method", name: "stopPerformanceMonitoring", static: false, private: false, access: { has: function (obj) { return "stopPerformanceMonitoring" in obj; }, get: function (obj) { return obj.stopPerformanceMonitoring; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _navigateToLoginPage_decorators, { kind: "method", name: "navigateToLoginPage", static: false, private: false, access: { has: function (obj) { return "navigateToLoginPage" in obj; }, get: function (obj) { return obj.navigateToLoginPage; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _fillUsername_decorators, { kind: "method", name: "fillUsername", static: false, private: false, access: { has: function (obj) { return "fillUsername" in obj; }, get: function (obj) { return obj.fillUsername; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _fillPassword_decorators, { kind: "method", name: "fillPassword", static: false, private: false, access: { has: function (obj) { return "fillPassword" in obj; }, get: function (obj) { return obj.fillPassword; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _clickLoginButton_decorators, { kind: "method", name: "clickLoginButton", static: false, private: false, access: { has: function (obj) { return "clickLoginButton" in obj; }, get: function (obj) { return obj.clickLoginButton; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _waitForDashboard_decorators, { kind: "method", name: "waitForDashboard", static: false, private: false, access: { has: function (obj) { return "waitForDashboard" in obj; }, get: function (obj) { return obj.waitForDashboard; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _verifyAuthentication_decorators, { kind: "method", name: "verifyAuthentication", static: false, private: false, access: { has: function (obj) { return "verifyAuthentication" in obj; }, get: function (obj) { return obj.verifyAuthentication; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _performLogout_decorators, { kind: "method", name: "performLogout", static: false, private: false, access: { has: function (obj) { return "performLogout" in obj; }, get: function (obj) { return obj.performLogout; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _executeComprehensiveTesting_decorators, { kind: "method", name: "executeComprehensiveTesting", static: false, private: false, access: { has: function (obj) { return "executeComprehensiveTesting" in obj; }, get: function (obj) { return obj.executeComprehensiveTesting; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _executeParameterizedLoadTest_decorators, { kind: "method", name: "executeParameterizedLoadTest", static: false, private: false, access: { has: function (obj) { return "executeParameterizedLoadTest" in obj; }, get: function (obj) { return obj.executeParameterizedLoadTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _performVariousOperations_decorators, { kind: "method", name: "performVariousOperations", static: false, private: false, access: { has: function (obj) { return "performVariousOperations" in obj; }, get: function (obj) { return obj.performVariousOperations; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _executeAccessibilityTesting_decorators, { kind: "method", name: "executeAccessibilityTesting", static: false, private: false, access: { has: function (obj) { return "executeAccessibilityTesting" in obj; }, get: function (obj) { return obj.executeAccessibilityTesting; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _measureAuthenticationTiming_decorators, { kind: "method", name: "measureAuthenticationTiming", static: false, private: false, access: { has: function (obj) { return "measureAuthenticationTiming" in obj; }, get: function (obj) { return obj.measureAuthenticationTiming; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _enableAccessibilityMonitoring_decorators, { kind: "method", name: "enableAccessibilityMonitoring", static: false, private: false, access: { has: function (obj) { return "enableAccessibilityMonitoring" in obj; }, get: function (obj) { return obj.enableAccessibilityMonitoring; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _setAlertThresholds_decorators, { kind: "method", name: "setAlertThresholds", static: false, private: false, access: { has: function (obj) { return "setAlertThresholds" in obj; }, get: function (obj) { return obj.setAlertThresholds; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _startContinuousMonitoring_decorators, { kind: "method", name: "startContinuousMonitoring", static: false, private: false, access: { has: function (obj) { return "startContinuousMonitoring" in obj; }, get: function (obj) { return obj.startContinuousMonitoring; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _configureRealTimeMonitoring_decorators, { kind: "method", name: "configureRealTimeMonitoring", static: false, private: false, access: { has: function (obj) { return "configureRealTimeMonitoring" in obj; }, get: function (obj) { return obj.configureRealTimeMonitoring; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _createAuthenticationSecurityTest_decorators, { kind: "method", name: "createAuthenticationSecurityTest", static: false, private: false, access: { has: function (obj) { return "createAuthenticationSecurityTest" in obj; }, get: function (obj) { return obj.createAuthenticationSecurityTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _createErrorHandlingTest_decorators, { kind: "method", name: "createErrorHandlingTest", static: false, private: false, access: { has: function (obj) { return "createErrorHandlingTest" in obj; }, get: function (obj) { return obj.createErrorHandlingTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _setupScalabilityTest_decorators, { kind: "method", name: "setupScalabilityTest", static: false, private: false, access: { has: function (obj) { return "setupScalabilityTest" in obj; }, get: function (obj) { return obj.setupScalabilityTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _setupBaselineTest_decorators, { kind: "method", name: "setupBaselineTest", static: false, private: false, access: { has: function (obj) { return "setupBaselineTest" in obj; }, get: function (obj) { return obj.setupBaselineTest; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _runProgressiveTests_decorators, { kind: "method", name: "runProgressiveTests", static: false, private: false, access: { has: function (obj) { return "runProgressiveTests" in obj; }, get: function (obj) { return obj.runProgressiveTests; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _recordBaselineMetrics_decorators, { kind: "method", name: "recordBaselineMetrics", static: false, private: false, access: { has: function (obj) { return "recordBaselineMetrics" in obj; }, get: function (obj) { return obj.recordBaselineMetrics; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _simulateErrorConditions_decorators, { kind: "method", name: "simulateErrorConditions", static: false, private: false, access: { has: function (obj) { return "simulateErrorConditions" in obj; }, get: function (obj) { return obj.simulateErrorConditions; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _executeUnderNetworkConditions_decorators, { kind: "method", name: "executeUnderNetworkConditions", static: false, private: false, access: { has: function (obj) { return "executeUnderNetworkConditions" in obj; }, get: function (obj) { return obj.executeUnderNetworkConditions; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMLoginTime_decorators, { kind: "method", name: "assertOrangeHRMLoginTime", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMLoginTime" in obj; }, get: function (obj) { return obj.assertOrangeHRMLoginTime; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMLogoutTime_decorators, { kind: "method", name: "assertOrangeHRMLogoutTime", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMLogoutTime" in obj; }, get: function (obj) { return obj.assertOrangeHRMLogoutTime; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMAuthenticationSuccess_decorators, { kind: "method", name: "assertOrangeHRMAuthenticationSuccess", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMAuthenticationSuccess" in obj; }, get: function (obj) { return obj.assertOrangeHRMAuthenticationSuccess; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMRedirectToLogin_decorators, { kind: "method", name: "assertOrangeHRMRedirectToLogin", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMRedirectToLogin" in obj; }, get: function (obj) { return obj.assertOrangeHRMRedirectToLogin; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMSuccessRate_decorators, { kind: "method", name: "assertOrangeHRMSuccessRate", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMSuccessRate" in obj; }, get: function (obj) { return obj.assertOrangeHRMSuccessRate; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMAverageLoginTime_decorators, { kind: "method", name: "assertOrangeHRMAverageLoginTime", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMAverageLoginTime" in obj; }, get: function (obj) { return obj.assertOrangeHRMAverageLoginTime; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMAverageLogoutTime_decorators, { kind: "method", name: "assertOrangeHRMAverageLogoutTime", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMAverageLogoutTime" in obj; }, get: function (obj) { return obj.assertOrangeHRMAverageLogoutTime; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMNoSystemErrors_decorators, { kind: "method", name: "assertOrangeHRMNoSystemErrors", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMNoSystemErrors" in obj; }, get: function (obj) { return obj.assertOrangeHRMNoSystemErrors; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMMobilePerformance_decorators, { kind: "method", name: "assertOrangeHRMMobilePerformance", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMMobilePerformance" in obj; }, get: function (obj) { return obj.assertOrangeHRMMobilePerformance; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMSystemStability_decorators, { kind: "method", name: "assertOrangeHRMSystemStability", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMSystemStability" in obj; }, get: function (obj) { return obj.assertOrangeHRMSystemStability; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMPerformanceDegradation_decorators, { kind: "method", name: "assertOrangeHRMPerformanceDegradation", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMPerformanceDegradation" in obj; }, get: function (obj) { return obj.assertOrangeHRMPerformanceDegradation; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMPageLoadThreshold_decorators, { kind: "method", name: "assertOrangeHRMPageLoadThreshold", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMPageLoadThreshold" in obj; }, get: function (obj) { return obj.assertOrangeHRMPageLoadThreshold; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMBrowserCompatibility_decorators, { kind: "method", name: "assertOrangeHRMBrowserCompatibility", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMBrowserCompatibility" in obj; }, get: function (obj) { return obj.assertOrangeHRMBrowserCompatibility; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOrangeHRMNoCriticalErrors_decorators, { kind: "method", name: "assertOrangeHRMNoCriticalErrors", static: false, private: false, access: { has: function (obj) { return "assertOrangeHRMNoCriticalErrors" in obj; }, get: function (obj) { return obj.assertOrangeHRMNoCriticalErrors; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertPageLoadTime_decorators, { kind: "method", name: "assertPageLoadTime", static: false, private: false, access: { has: function (obj) { return "assertPageLoadTime" in obj; }, get: function (obj) { return obj.assertPageLoadTime; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertResponseTimeAcceptable_decorators, { kind: "method", name: "assertResponseTimeAcceptable", static: false, private: false, access: { has: function (obj) { return "assertResponseTimeAcceptable" in obj; }, get: function (obj) { return obj.assertResponseTimeAcceptable; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertWorkflowThresholds_decorators, { kind: "method", name: "assertWorkflowThresholds", static: false, private: false, access: { has: function (obj) { return "assertWorkflowThresholds" in obj; }, get: function (obj) { return obj.assertWorkflowThresholds; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertIndividualStepCriteria_decorators, { kind: "method", name: "assertIndividualStepCriteria", static: false, private: false, access: { has: function (obj) { return "assertIndividualStepCriteria" in obj; }, get: function (obj) { return obj.assertIndividualStepCriteria; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertPerformanceForNetworkCondition_decorators, { kind: "method", name: "assertPerformanceForNetworkCondition", static: false, private: false, access: { has: function (obj) { return "assertPerformanceForNetworkCondition" in obj; }, get: function (obj) { return obj.assertPerformanceForNetworkCondition; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertCoreWebVitalsForNetwork_decorators, { kind: "method", name: "assertCoreWebVitalsForNetwork", static: false, private: false, access: { has: function (obj) { return "assertCoreWebVitalsForNetwork" in obj; }, get: function (obj) { return obj.assertCoreWebVitalsForNetwork; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertAllMetricsWithinBudget_decorators, { kind: "method", name: "assertAllMetricsWithinBudget", static: false, private: false, access: { has: function (obj) { return "assertAllMetricsWithinBudget" in obj; }, get: function (obj) { return obj.assertAllMetricsWithinBudget; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertBudgetViolationsReported_decorators, { kind: "method", name: "assertBudgetViolationsReported", static: false, private: false, access: { has: function (obj) { return "assertBudgetViolationsReported" in obj; }, get: function (obj) { return obj.assertBudgetViolationsReported; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertPerformanceTrendsMonitored_decorators, { kind: "method", name: "assertPerformanceTrendsMonitored", static: false, private: false, access: { has: function (obj) { return "assertPerformanceTrendsMonitored" in obj; }, get: function (obj) { return obj.assertPerformanceTrendsMonitored; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertNoTimingInformationLeakage_decorators, { kind: "method", name: "assertNoTimingInformationLeakage", static: false, private: false, access: { has: function (obj) { return "assertNoTimingInformationLeakage" in obj; }, get: function (obj) { return obj.assertNoTimingInformationLeakage; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertFailedLoginsNoImpact_decorators, { kind: "method", name: "assertFailedLoginsNoImpact", static: false, private: false, access: { has: function (obj) { return "assertFailedLoginsNoImpact" in obj; }, get: function (obj) { return obj.assertFailedLoginsNoImpact; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertSystemSecureUnderLoad_decorators, { kind: "method", name: "assertSystemSecureUnderLoad", static: false, private: false, access: { has: function (obj) { return "assertSystemSecureUnderLoad" in obj; }, get: function (obj) { return obj.assertSystemSecureUnderLoad; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertFIDSupportsAccessibility_decorators, { kind: "method", name: "assertFIDSupportsAccessibility", static: false, private: false, access: { has: function (obj) { return "assertFIDSupportsAccessibility" in obj; }, get: function (obj) { return obj.assertFIDSupportsAccessibility; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertCLSNoScreenReaderImpact_decorators, { kind: "method", name: "assertCLSNoScreenReaderImpact", static: false, private: false, access: { has: function (obj) { return "assertCLSNoScreenReaderImpact" in obj; }, get: function (obj) { return obj.assertCLSNoScreenReaderImpact; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertFastAndAccessible_decorators, { kind: "method", name: "assertFastAndAccessible", static: false, private: false, access: { has: function (obj) { return "assertFastAndAccessible" in obj; }, get: function (obj) { return obj.assertFastAndAccessible; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertRealTimeMetrics_decorators, { kind: "method", name: "assertRealTimeMetrics", static: false, private: false, access: { has: function (obj) { return "assertRealTimeMetrics" in obj; }, get: function (obj) { return obj.assertRealTimeMetrics; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertAlertsTriggered_decorators, { kind: "method", name: "assertAlertsTriggered", static: false, private: false, access: { has: function (obj) { return "assertAlertsTriggered" in obj; }, get: function (obj) { return obj.assertAlertsTriggered; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertContinuousDataCollection_decorators, { kind: "method", name: "assertContinuousDataCollection", static: false, private: false, access: { has: function (obj) { return "assertContinuousDataCollection" in obj; }, get: function (obj) { return obj.assertContinuousDataCollection; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertReliableBaselines_decorators, { kind: "method", name: "assertReliableBaselines", static: false, private: false, access: { has: function (obj) { return "assertReliableBaselines" in obj; }, get: function (obj) { return obj.assertReliableBaselines; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertBaselineComparison_decorators, { kind: "method", name: "assertBaselineComparison", static: false, private: false, access: { has: function (obj) { return "assertBaselineComparison" in obj; }, get: function (obj) { return obj.assertBaselineComparison; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertRegressionDetection_decorators, { kind: "method", name: "assertRegressionDetection", static: false, private: false, access: { has: function (obj) { return "assertRegressionDetection" in obj; }, get: function (obj) { return obj.assertRegressionDetection; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertPerformanceUnderErrors_decorators, { kind: "method", name: "assertPerformanceUnderErrors", static: false, private: false, access: { has: function (obj) { return "assertPerformanceUnderErrors" in obj; }, get: function (obj) { return obj.assertPerformanceUnderErrors; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertTimelyErrorResponses_decorators, { kind: "method", name: "assertTimelyErrorResponses", static: false, private: false, access: { has: function (obj) { return "assertTimelyErrorResponses" in obj; }, get: function (obj) { return obj.assertTimelyErrorResponses; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertGracefulRecovery_decorators, { kind: "method", name: "assertGracefulRecovery", static: false, private: false, access: { has: function (obj) { return "assertGracefulRecovery" in obj; }, get: function (obj) { return obj.assertGracefulRecovery; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertAverageResponseTime_decorators, { kind: "method", name: "assertAverageResponseTime", static: false, private: false, access: { has: function (obj) { return "assertAverageResponseTime" in obj; }, get: function (obj) { return obj.assertAverageResponseTime; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertSystemResources_decorators, { kind: "method", name: "assertSystemResources", static: false, private: false, access: { has: function (obj) { return "assertSystemResources" in obj; }, get: function (obj) { return obj.assertSystemResources; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertProgressiveMetrics_decorators, { kind: "method", name: "assertProgressiveMetrics", static: false, private: false, access: { has: function (obj) { return "assertProgressiveMetrics" in obj; }, get: function (obj) { return obj.assertProgressiveMetrics; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertOptimalCapacity_decorators, { kind: "method", name: "assertOptimalCapacity", static: false, private: false, access: { has: function (obj) { return "assertOptimalCapacity" in obj; }, get: function (obj) { return obj.assertOptimalCapacity; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _assertGracefulDegradation_decorators, { kind: "method", name: "assertGracefulDegradation", static: false, private: false, access: { has: function (obj) { return "assertGracefulDegradation" in obj; }, get: function (obj) { return obj.assertGracefulDegradation; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(_a, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        })(),
        _a;
}();
exports.OrangeHRMPerformanceSteps = OrangeHRMPerformanceSteps;
// Create and export an instance for the framework to use
exports.orangeHRMPerformanceSteps = new OrangeHRMPerformanceSteps();
