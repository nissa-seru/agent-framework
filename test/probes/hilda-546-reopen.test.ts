/**
 * A probe for agent-framework #546 (Dendrite), by Hilda-2681. Not part of the
 * PR. Run at be26b1af and 6ba5f166.
 *
 * Two residents share the conversation slot: messages added to one's context
 * are in the other's. Then the store is reopened with only the first one
 * configured, so the second is recorded as ended (`not-configured`). Asking
 * for its context (inspectAgentContext) should show what it read while live.
 *
 * The probe asserts the defect as found: the dropped resident reopens as an
 * isolated namespace of its own, with none of the messages it saw. Observed
 * values are logged as PROBE-R JSON.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework, AutobiographicalStrategy } from '../../src/index.js';
import type { AgentConfig, ContextStrategy } from '../../src/index.js';
import { GateModule, RoutedMembrane } from '../helpers/dendrite.js';

function folding(): ContextStrategy {
  return new AutobiographicalStrategy({
    compressionModel: 'mock',
    adaptiveResolution: true,
    targetChunkTokens: 100,
    recentWindowTokens: 200,
  }) as unknown as ContextStrategy;
}

describe('probe R: a resident dropped from configuration, reopened', () => {
  let tempDir: string;
  let framework: AgentFramework | undefined;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'hilda-546-reopen-')); });
  afterEach(async () => {
    try { await framework?.stop(); } catch { /* already stopped */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('R: it reopens as an isolated namespace, with none of the 6 messages it saw while live', async () => {
    const membrane = new RoutedMembrane();
    membrane.completion = '[mock summary]';
    const config = (name: string): AgentConfig => ({
      name, model: 'test-model', systemPrompt: `You are ${name}.`, strategy: folding(), contextBudgetTokens: 3200, maxTokens: 200,
    });
    const open = (names: string[]) => AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: names.map(config),
      modules: [new GateModule()],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });

    framework = await open(['mira', 'nova']);
    const slot = framework.getAgent('mira')!.getContextManager();
    for (let i = 0; i < 6; i++) slot.addMessage(i % 2 ? 'nova' : 'user', [{ type: 'text', text: `Shared ${i}.` }]);
    const novaSeesWhileLive = framework.getAgent('nova')!.getContextManager().getAllMessages().length;
    await framework.stop();

    framework = await open(['mira']);
    framework.start();
    const record = framework.getAgentRecord('nova');
    const reopened = await framework.inspectAgentContext('nova').then(
      (cm) => cm.getAllMessages().length, (e: Error) => `refused: ${e.message}`);
    const observed = { novaSeesWhileLive, ended: record?.ended?.reason ?? null, namespace: record?.namespace ?? null, reopenedCount: reopened };
    console.log(`# PROBE-R ${JSON.stringify(observed)}`);
    assert.equal(observed.novaSeesWhileLive, 6, 'nova reads the shared slot while live');
    assert.equal(observed.ended, 'not-configured');
    assert.equal(observed.reopenedCount, 0, 'predicted: it reopens with none of what it saw');
  });
});
