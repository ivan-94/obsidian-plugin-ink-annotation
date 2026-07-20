import { describe, expect, it, vi } from 'vitest';

import { InkPerformanceDiagnostics } from './ink-performance-diagnostics';
import { InkPresentationGenerationLedger } from './ink-presentation-generation-ledger';

describe('InkPresentationGenerationLedger', () => {
  it('settles every batch coalesced into one Presentation Frame Generation exactly once', () => {
    let now = 100;
    const diagnostics = new InkPerformanceDiagnostics(true, () => now);
    const contact = diagnostics.openContact('pointer');
    const submittedDurations: number[] = [];
    const ledger = new InkPresentationGenerationLedger({
      diagnostics,
      now: () => now,
      onSubmitted: (durationMs) => submittedDurations.push(durationMs),
    });
    const firstSpan = diagnostics.beginSpan('ink-input-to-submit', {
      contact,
      workPhase: 'input',
    });
    const finishFirst = vi.spyOn(firstSpan, 'finish');

    const firstGeneration = ledger.begin(contact, 2, firstSpan);
    now = 104;
    const secondGeneration = ledger.begin(
      contact,
      3,
      diagnostics.beginSpan('ink-input-to-submit', { contact, workPhase: 'input' }),
    );
    now = 108;
    ledger.settle(firstGeneration, contact);
    ledger.settle(firstGeneration, contact);

    expect(secondGeneration).toBe(firstGeneration);
    expect(finishFirst).toHaveBeenCalledOnce();
    expect(submittedDurations).toEqual([8]);
    expect(
      diagnostics.snapshot().recentSpans.filter(({ name }) => name === 'ink-input-to-submit'),
    ).toEqual([
      expect.objectContaining({
        accepted: true,
        batchSequence: 1,
        contactSequence: contact.sequence,
        presentationOutcome: 'submitted',
        requestedGeneration: firstGeneration,
        sampleCountBucket: '2-4',
        submittedGeneration: firstGeneration,
      }),
      expect.objectContaining({
        accepted: true,
        batchSequence: 2,
        contactSequence: contact.sequence,
        presentationOutcome: 'submitted',
        requestedGeneration: firstGeneration,
        sampleCountBucket: '2-4',
        submittedGeneration: firstGeneration,
      }),
    ]);
  });

  it('classifies an unsubmitted contact end as cancelled', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const contact = diagnostics.openContact('pointer');
    const ledger = new InkPresentationGenerationLedger({ diagnostics });
    const generation = ledger.begin(
      contact,
      1,
      diagnostics.beginSpan('ink-input-to-submit', { contact, workPhase: 'input' }),
    );

    ledger.cancel('cancelled');
    ledger.settle(generation, contact);

    expect(
      diagnostics.snapshot().recentSpans.filter(({ name }) => name === 'ink-input-to-submit'),
    ).toEqual([
      expect.objectContaining({
        accepted: false,
        batchSequence: 1,
        presentationOutcome: 'cancelled',
        requestedGeneration: generation,
        submittedGeneration: null,
      }),
    ]);
  });

  it('supersedes stale ownership before a new contact begins', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const firstContact = diagnostics.openContact('pointer');
    const ledger = new InkPresentationGenerationLedger({ diagnostics });
    const firstGeneration = ledger.begin(
      firstContact,
      1,
      diagnostics.beginSpan('ink-input-to-submit', {
        contact: firstContact,
        workPhase: 'input',
      }),
    );
    const secondContact = diagnostics.openContact('pointer');
    const secondGeneration = ledger.begin(
      secondContact,
      1,
      diagnostics.beginSpan('ink-input-to-submit', {
        contact: secondContact,
        workPhase: 'input',
      }),
    );

    ledger.settle(secondGeneration, secondContact);

    expect(secondGeneration).toBe(firstGeneration + 1);
    expect(
      diagnostics
        .snapshot()
        .recentSpans.filter(({ name }) => name === 'ink-input-to-submit')
        .map(
          ({
            accepted,
            batchSequence,
            contactSequence,
            presentationOutcome,
            requestedGeneration,
            submittedGeneration,
          }) => ({
            accepted,
            batchSequence,
            contactSequence,
            presentationOutcome,
            requestedGeneration,
            submittedGeneration,
          }),
        ),
    ).toEqual([
      {
        accepted: false,
        batchSequence: 1,
        contactSequence: firstContact.sequence,
        presentationOutcome: 'superseded',
        requestedGeneration: firstGeneration,
        submittedGeneration: null,
      },
      {
        accepted: true,
        batchSequence: 1,
        contactSequence: secondContact.sequence,
        presentationOutcome: 'submitted',
        requestedGeneration: secondGeneration,
        submittedGeneration: secondGeneration,
      },
    ]);
  });

  it('fails closed as superseded when the bounded pending ledger overflows', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const contact = diagnostics.openContact('pointer');
    const ledger = new InkPresentationGenerationLedger({
      diagnostics,
      maxPendingBatches: 2,
    });
    let generation = 0;
    for (let index = 0; index < 3; index += 1) {
      generation = ledger.begin(
        contact,
        1,
        diagnostics.beginSpan('ink-input-to-submit', { contact, workPhase: 'input' }),
      );
    }

    ledger.settle(generation, contact);

    expect(
      diagnostics
        .snapshot()
        .recentSpans.filter(({ name }) => name === 'ink-input-to-submit')
        .map(({ batchSequence, presentationOutcome }) => ({
          batchSequence,
          presentationOutcome,
        })),
    ).toEqual([
      { batchSequence: 1, presentationOutcome: 'superseded' },
      { batchSequence: 2, presentationOutcome: 'submitted' },
      { batchSequence: 3, presentationOutcome: 'submitted' },
    ]);
  });

  it('only marks the exact cancelled generation as unpresented', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const contact = diagnostics.openContact('pointer');
    const ledger = new InkPresentationGenerationLedger({ diagnostics });
    const generation = ledger.begin(
      contact,
      1,
      diagnostics.beginSpan('ink-input-to-submit', { contact, workPhase: 'input' }),
    );

    ledger.cancel('unpresented', generation + 1);
    ledger.settle(generation, contact);

    expect(
      diagnostics.snapshot().recentSpans.find(({ name }) => name === 'ink-input-to-submit'),
    ).toEqual(
      expect.objectContaining({
        accepted: true,
        presentationOutcome: 'submitted',
        requestedGeneration: generation,
        submittedGeneration: generation,
      }),
    );
  });

  it('does not let an unrelated newer callback retire the owned generation', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const contact = diagnostics.openContact('pointer');
    const ledger = new InkPresentationGenerationLedger({ diagnostics });
    const generation = ledger.begin(
      contact,
      1,
      diagnostics.beginSpan('ink-input-to-submit', { contact, workPhase: 'input' }),
    );

    ledger.settle(generation + 1, contact);
    ledger.settle(generation, contact);

    expect(
      diagnostics.snapshot().recentSpans.find(({ name }) => name === 'ink-input-to-submit'),
    ).toEqual(
      expect.objectContaining({
        accepted: true,
        presentationOutcome: 'submitted',
        requestedGeneration: generation,
        submittedGeneration: generation,
      }),
    );
  });

  it('does not create or inspect pending diagnostic ownership while diagnostics are disabled', () => {
    const diagnostics = new InkPerformanceDiagnostics(false);
    const contact = diagnostics.openContact('pointer');
    const finish = vi.fn();
    const inspect = vi.fn();
    const poisonSpan = new Proxy(
      {},
      {
        get: (_target, property) => {
          inspect(property);
          return property === 'finish' ? finish : () => undefined;
        },
      },
    );
    const ledger = new InkPresentationGenerationLedger({
      diagnostics,
      maxPendingBatches: 1,
    });

    for (let index = 0; index < 1_000; index += 1) {
      ledger.begin(contact, 1, poisonSpan as never);
    }
    ledger.cancel('cancelled');

    expect(inspect).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(diagnostics.snapshot()).toMatchObject({
      hangingSpanCount: 0,
      recentSpans: [],
    });
  });
});
