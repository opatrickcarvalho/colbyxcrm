import { describe, expect, it } from 'vitest';

import { extractButtonReply } from './uazapi-inbound';

/**
 * The exact `content` object a real uazapi instance sent when a customer
 * tapped a one-button interactive message, captured from a production
 * webhook (participant id replaced with a synthetic one).
 *
 * Note the casing: `Response.SelectedDisplayText` and `selectedButtonID`.
 * A parser matching `selectedDisplayText` / `selectedButtonId` exactly
 * finds neither, which is how the tap ended up stored as a blank message
 * with no reply id — and why no `interactive_reply` automation could
 * ever fire.
 */
const REAL_BUTTON_TAP = {
  type: 1,
  Response: { SelectedDisplayText: 'Resposta 01' },
  contextInfo: {
    stanzaID: '3EB0A42B10F575F1735D55',
    participant: '000000000000000@lid',
    quotedMessage: {
      interactiveMessage: {
        body: { text: '\nOlá {{primeiro_nome}}.' },
        footer: { text: 'Rodapé', Media: null },
        header: { Media: null, title: '*Cabeçalho*' },
        InteractiveMessage: {
          NativeFlowMessage: {
            buttons: [
              {
                name: 'quick_reply',
                buttonParamsJSON:
                  '{"id": "btn_1", "display_text": "Resposta 01", "disabled": false}',
              },
            ],
          },
        },
      },
    },
  },
  selectedButtonID: 'btn_1',
};

describe('extractButtonReply', () => {
  it('reads the id and label from a real uazapi button tap', () => {
    expect(extractButtonReply(REAL_BUTTON_TAP)).toEqual({
      id: 'btn_1',
      title: 'Resposta 01',
    });
  });

  it('takes the pressed button, never one listed in the quoted original', () => {
    // The quoted message carries every button of the menu. Reading an id
    // from there would report the first one regardless of what was
    // actually pressed.
    const secondButtonPressed = {
      ...REAL_BUTTON_TAP,
      Response: { SelectedDisplayText: 'Resposta 02' },
      selectedButtonID: 'btn_2',
      contextInfo: {
        quotedMessage: {
          interactiveMessage: {
            InteractiveMessage: {
              NativeFlowMessage: {
                buttons: [
                  { name: 'quick_reply', buttonParamsJSON: '{"id": "btn_1"}' },
                  { name: 'quick_reply', buttonParamsJSON: '{"id": "btn_2"}' },
                ],
              },
            },
          },
        },
      },
    };
    expect(extractButtonReply(secondButtonPressed)).toEqual({
      id: 'btn_2',
      title: 'Resposta 02',
    });
  });

  it('still reads the flattened shape the parser was originally written for', () => {
    expect(
      extractButtonReply({ selectedDisplayText: 'Sim', selectedID: 'yes' })
    ).toEqual({ id: 'yes', title: 'Sim' });
  });

  it('reads the nested buttons / template / list envelopes', () => {
    expect(
      extractButtonReply({
        buttonsResponseMessage: {
          selectedButtonId: 'opt_a',
          selectedDisplayText: 'Opção A',
        },
      })
    ).toEqual({ id: 'opt_a', title: 'Opção A' });

    expect(
      extractButtonReply({
        templateButtonReplyMessage: {
          selectedId: 'tpl_1',
          selectedDisplayText: 'Modelo 1',
        },
      })
    ).toEqual({ id: 'tpl_1', title: 'Modelo 1' });

    expect(
      extractButtonReply({
        listResponseMessage: {
          title: 'Horário de atendimento',
          singleSelectReply: { selectedRowId: 'row_hours' },
        },
      })
    ).toEqual({ id: 'row_hours', title: 'Horário de atendimento' });
  });

  it('reads a native-flow quick reply, whose id is a JSON string', () => {
    expect(
      extractButtonReply({
        interactiveResponseMessage: {
          body: { text: 'Falar com humano' },
          nativeFlowResponseMessage: {
            name: 'quick_reply',
            paramsJson: '{"id":"talk_human"}',
          },
        },
      })
    ).toEqual({ id: 'talk_human', title: 'Falar com humano' });
  });

  it('falls back to the label when only one half is present', () => {
    // Better a message that reads correctly in the thread than a blank
    // one; the id simply mirrors whichever half arrived.
    expect(
      extractButtonReply({ Response: { SelectedDisplayText: 'Só rótulo' } })
    ).toEqual({ id: 'Só rótulo', title: 'Só rótulo' });
    expect(extractButtonReply({ selectedButtonID: 'só_id' })).toEqual({
      id: 'só_id',
      title: 'só_id',
    });
  });

  it('returns null for an ordinary text message', () => {
    expect(extractButtonReply('Olá, tudo bem?')).toBeNull();
    expect(extractButtonReply(undefined)).toBeNull();
    expect(extractButtonReply({ conversation: 'Olá' })).toBeNull();
  });

  it('survives malformed native-flow JSON instead of throwing', () => {
    expect(
      extractButtonReply({
        interactiveResponseMessage: {
          nativeFlowResponseMessage: { paramsJson: '{not json' },
        },
      })
    ).toBeNull();
  });
});
