import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaileysAdapter } from './adapters/baileys.adapter';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { ENGINE_CAPABILITY_MATRIX } from './engine-capability-matrix';

/**
 * Drift invariants for the engine capability matrix. The matrix's `status` (supported /
 * not-available) is hand-curated and richer than a throw-scan: it also marks "phantom support"
 * methods (adapter stubs that return null/[] without throwing — see docs/29-engine-capability-matrix.md).
 * So the gate asserts the invariants a throw-scan CAN verify, not full equality:
 *
 *   1. A method whose adapter body throws EngineNotSupportedError/ChannelMediaNotSupportedError
 *      MUST be `not-available` in the matrix (throws always mean unavailable).
 *   2. A method the matrix marks `supported` MUST NOT throw.
 *
 * The allowed gap (not deliberate drift): a method that is `not-available` but does not throw today
 * — a phantom stub. Those are hand-tracked in the matrix; a throw-scan cannot see them. If an adapter
 * method starts or stops throwing, one of the invariants trips and forces a deliberate matrix update.
 *
 * No engine is instantiated and no Chromium/socket is opened: it reads method bodies via
 * `Class.prototype.method.toString()`, a fast hermetic structural check.
 */
const UNSUPPORTED_RE = /this\.unsupported\(|EngineNotSupportedError|ChannelMediaNotSupportedError/;

function readInterfaceMethods(): string[] {
  const src = readFileSync(join(__dirname, 'interfaces', 'whatsapp-engine.interface.ts'), 'utf8');
  const names = new Set<string>();
  for (const line of src.split('\n')) {
    const match = line.match(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*\(/);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

type AdapterCtor = { prototype: Record<string, unknown> };
type AdapterKey = 'wwjs' | 'baileys';
const ADAPTERS: ReadonlyArray<[AdapterKey, AdapterCtor]> = [
  ['wwjs', WhatsAppWebJsAdapter as unknown as AdapterCtor],
  ['baileys', BaileysAdapter as unknown as AdapterCtor],
];

/**
 * Unsupported-throws that live in DELEGATE modules rather than in the adapter prototype.
 *
 * The prototype scan reads a method's own body text, so once an adapter method forwards to a
 * delegate its `EngineNotSupportedError` becomes invisible and BOTH invariants stop applying to it:
 * a genuinely unsupported method could be marked `supported` and the gate would say nothing. That is
 * not hypothetical — every wwjs unsupported-throw except a handful now lives in a `wwebjs-*` module.
 *
 * Every throw site names its own method as a string literal, so the registry is derived from those
 * literals instead of by following delegation, which would mean resolving call graphs in a spec.
 * Bucketed by filename because that is what identifies the engine: `baileys*` is Baileys, the wwjs
 * adapter and its `wwebjs-*` delegates are wwjs.
 */
function readDelegateThrows(): Record<string, Set<string>> {
  const dir = join(__dirname, 'adapters');
  const registry: Record<string, Set<string>> = { wwjs: new Set(), baileys: new Set() };
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
    const engine = file.startsWith('baileys') ? 'baileys' : 'wwjs';
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(/(?:new EngineNotSupportedError|this\.unsupported)\(\s*'([a-zA-Z][a-zA-Z0-9]*)'/g)) {
      registry[engine].add(m[1]);
    }
  }
  return registry;
}

const DELEGATE_THROWS = readDelegateThrows();

function liveThrows(adapter: AdapterCtor, method: string, engine: string): boolean {
  if (DELEGATE_THROWS[engine].has(method)) return true;
  const fn = adapter.prototype[method];
  if (typeof fn !== 'function') return true; // missing method = effectively unavailable
  return UNSUPPORTED_RE.test(String(fn));
}

describe('engine capability matrix — drift invariants', () => {
  const methods = readInterfaceMethods();
  const matrixKeys = Object.keys(ENGINE_CAPABILITY_MATRIX).sort();

  // Guard against a pattern that silently stops matching: an empty registry would make the widened
  // scan collapse back to the prototype-only one without a single test turning red.
  it('the delegate throw registry actually found the delegated throws', () => {
    expect(DELEGATE_THROWS.wwjs.size).toBeGreaterThanOrEqual(5);
    // Known-positive: getCatalog's throw lives in wwebjs-catalog.ts, not in the adapter prototype.
    expect(DELEGATE_THROWS.wwjs.has('getCatalog')).toBe(true);
    // Indexed rather than dotted so the unbound-method rule does not fire: this reads the body TEXT,
    // it never calls the method.
    const body = String((WhatsAppWebJsAdapter.prototype as unknown as Record<string, unknown>)['getCatalog']);
    expect(body).not.toMatch(UNSUPPORTED_RE);
  });

  it('matrix keys exactly match the interface methods (no missing, no stale)', () => {
    const missing = methods.filter(m => !(m in ENGINE_CAPABILITY_MATRIX));
    const stale = matrixKeys.filter(k => !methods.includes(k));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it.each(methods)('%s: throws ⇒ not-available, supported ⇒ not-throws', method => {
    const entry = ENGINE_CAPABILITY_MATRIX[method];
    for (const [adapter, ctor] of ADAPTERS) {
      const throws = liveThrows(ctor, method, adapter);
      const status = entry[adapter].status;
      if (throws) {
        expect({ method, adapter, status }).toEqual({ method, adapter, status: 'not-available' });
      }
      if (status === 'supported') {
        expect({ method, adapter, throws }).toEqual({ method, adapter, throws: false });
      }
    }
  });
});
