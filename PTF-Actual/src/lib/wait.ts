/**
 * CS Smart Wait Module Exports
 * @module wait
 */

// Core engine
export { CSSmartWaitEngine } from '../wait/CSSmartWaitEngine';
export type { BeforeActionContext, AfterActionContext, WaitResult } from '../wait/CSSmartWaitEngine';

// Configuration
export { CSSmartWaitConfig, SmartWaitLevel } from '../wait/CSSmartWaitConfig';
export type { SmartWaitOptions } from '../wait/CSSmartWaitConfig';

// Individual components
export { CSDomStabilityMonitor } from '../wait/CSDomStabilityMonitor';
export type { DomStabilityOptions } from '../wait/CSDomStabilityMonitor';

export { CSNetworkIdleTracker } from '../wait/CSNetworkIdleTracker';
export type { NetworkIdleOptions } from '../wait/CSNetworkIdleTracker';

export { CSSpinnerDetector } from '../wait/CSSpinnerDetector';
export type { SpinnerDetectorOptions } from '../wait/CSSpinnerDetector';

export { CSAnimationDetector } from '../wait/CSAnimationDetector';
export type { AnimationDetectorOptions } from '../wait/CSAnimationDetector';

export { CSSmartPoller } from '../wait/CSSmartPoller';
export type { SmartPollOptions, PollResult, BackoffStrategy } from '../wait/CSSmartPoller';
