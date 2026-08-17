import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults'

describe('buildSystemPrompt', () => {
  it('includes the current date/time so relative-date questions are resolvable', () => {
    // Without this, the model has no way to resolve "amanhã"/"hoje"
    // against the business hours in the context below and was handing
    // off answerable questions instead of checking the weekday.
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(prompt).toMatch(/Current date and time: .+\(America\/Sao_Paulo\)/)
  })

  it('still includes the business context and the handoff instruction', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'Aberto seg-sex 11h-14h30.',
      mode: 'auto_reply',
    })
    expect(prompt).toContain('Aberto seg-sex 11h-14h30.')
    expect(prompt).toContain(HANDOFF_SENTINEL)
  })

  it('omits the handoff instruction in draft mode', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(prompt).not.toContain(HANDOFF_SENTINEL)
  })
})
