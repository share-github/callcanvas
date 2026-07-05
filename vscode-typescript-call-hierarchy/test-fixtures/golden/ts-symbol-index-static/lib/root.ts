import { MAX_RETRY, Status } from './constants';

export function describeApp(): string {
    const s = Status.Active;
    const n = MAX_RETRY;
    return s + String(n);
}
