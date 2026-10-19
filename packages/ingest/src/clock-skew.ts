/**
 * Local clock versus ledger close time (#18).
 *
 * `ledgerClosedAt` is trusted as-is and turned into a Unix timestamp on insert,
 * so a badly skewed local clock silently corrupts every time-based query built
 * on it. Comparing the local clock with the network's own latest close time at
 * startup turns that into a warning instead of a wrong answer.
 */

/**
 * Skew beyond this is reported. Ledgers close roughly every 5 seconds and the
 * latest one is a few seconds old by the time it is read, so a threshold much
 * below a minute would warn on a perfectly healthy machine.
 */
export const DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS = 60;

export interface ClockSkew {
  /** Sequence of the ledger the comparison used. */
  latestLedger: number;
  /** That ledger's close time, ISO 8601. */
  ledgerCloseTime: string;
  /** The local clock at the moment of comparison, ISO 8601. */
  localTime: string;
  /**
   * Local minus ledger close time, in whole seconds. Positive means the local
   * clock is ahead of the network — or the RPC node is lagging behind it; the
   * two are indistinguishable from here, and the doctor message says so.
   */
  skewSeconds: number;
  thresholdSeconds: number;
  /** `|skewSeconds|` is strictly greater than the threshold. */
  exceedsThreshold: boolean;
}

/**
 * Compare a ledger close time (Unix seconds, as `getLatestLedger` reports it —
 * a number or a numeric string) with the local clock.
 *
 * @throws if `closeTime` is not a usable Unix timestamp. The RPC always sends
 *   one, so an unparseable value means the node is not speaking the protocol
 *   this expects, which is worth failing loudly on rather than reporting "0s".
 */
export function measureClockSkew(
  latestLedger: number,
  closeTime: string | number,
  nowMs: number = Date.now(),
  thresholdSeconds: number = DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS,
): ClockSkew {
  const closeSeconds = typeof closeTime === 'number' ? closeTime : Number(closeTime);
  if (closeTime === '' || !Number.isFinite(closeSeconds) || closeSeconds <= 0) {
    throw new Error(`getLatestLedger returned an unusable closeTime: ${JSON.stringify(closeTime)}`);
  }
  const skewSeconds = Math.round(nowMs / 1000 - closeSeconds);
  return {
    latestLedger,
    ledgerCloseTime: new Date(closeSeconds * 1000).toISOString(),
    localTime: new Date(nowMs).toISOString(),
    skewSeconds,
    thresholdSeconds,
    exceedsThreshold: Math.abs(skewSeconds) > thresholdSeconds,
  };
}

/**
 * Threshold from `LENS_CLOCK_SKEW_THRESHOLD_SECONDS`. An unusable value falls
 * back to the default: an operator who typo'd this wants the documented
 * behaviour, not a threshold of NaN that never warns.
 */
export function resolveClockSkewThreshold(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS;
}

/** One-paragraph explanation, shared by `lens doctor` and the indexer's startup warning. */
export function describeClockSkew(skew: ClockSkew): string {
  const direction = skew.skewSeconds >= 0 ? 'ahead of' : 'behind';
  return (
    `local clock is ${Math.abs(skew.skewSeconds)}s ${direction} ledger ${skew.latestLedger}'s close time ` +
    `(${skew.ledgerCloseTime}; local ${skew.localTime})`
  );
}
