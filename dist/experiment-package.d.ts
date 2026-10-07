import { type ExperimentAgent } from './experiment.js';
type Env = Record<string, string | undefined>;
/** Text the user pastes into another AI: the measured verdict plus the cases where cut content came back. */
export declare function experimentPackage(env: Env, agent: ExperimentAgent): Promise<string>;
export {};
