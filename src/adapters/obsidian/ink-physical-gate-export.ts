import {
  decodeS27ConditionMarker,
  type S27ConditionMarker,
} from '../../runtime/ink-physical-gate-capture';

interface PhysicalGateFileAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
}

const CONDITION_PATH = 'S27 Condition.json';
const DIAGNOSTICS_PATH = 'S27 Diagnostics.json';
const OWNERSHIP_PATH = '.inkstone-hat-owned';
const FIXTURE_MANIFEST_PATH = '.inkstone-s22-performance-hat.json';

/** Keeps physical Gate markers and diagnostics inside the explicitly owned synthetic Vault. */
export class InkPhysicalGateExport {
  constructor(private readonly adapter: PhysicalGateFileAdapter) {}

  async readCondition(): Promise<S27ConditionMarker> {
    await this.assertOwnedFixture();
    return decodeS27ConditionMarker(JSON.parse(await this.adapter.read(CONDITION_PATH)));
  }

  async writeCapture(capture: unknown): Promise<void> {
    await this.assertOwnedFixture();
    assertPrivacySafeCapture(capture);
    await this.adapter.write(DIAGNOSTICS_PATH, `${JSON.stringify(capture, null, 2)}\n`);
  }

  private async assertOwnedFixture(): Promise<void> {
    const [owned, fixture] = await Promise.all([
      this.adapter.exists(OWNERSHIP_PATH),
      this.adapter.exists(FIXTURE_MANIFEST_PATH),
    ]);
    if (!owned || !fixture) {
      throw new Error('S27 capture is allowed only in the owned synthetic Vault.');
    }
  }
}

function assertPrivacySafeCapture(value: unknown): void {
  const forbidden = new Set([
    'color',
    'coordinate',
    'deviceId',
    'fileContent',
    'filePath',
    'geometry',
    'noteContent',
    'path',
    'points',
    'pressure',
    'tilt',
    'x',
    'y',
  ]);
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (typeof candidate !== 'object' || candidate === null) return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (forbidden.has(key)) {
        throw new Error(`S27 diagnostics contain forbidden field: ${key}`);
      }
      visit(nested);
    }
  };
  visit(value);
}
