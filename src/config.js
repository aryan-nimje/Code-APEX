'use strict';
// Default project settings. Served to the frontend by /api/bootstrap.
// TQs are no longer listed here: they are produced by the detectors and the allocator
// from the uploaded IO list (see src/detectors.js and src/engine.js).
const defaults = {
  h: { cc: 4, bc: 8, pc: 12 },
  pat: '{c}-CBP-{n}',
  rules: [
    { k: 'ab', n: 'A and B never share a CIOC', d: 'Segregation', h: 1, on: 1 },
    { k: 'group', n: 'Each group stays in its own CIOCs', d: 'Grouping', h: 1, on: 1 },
    { k: 'spare', n: '10% spare per baseplate', d: 'Spare capacity', h: 0, on: 1 },
    { k: 'cable', n: 'Keep cable pairs together', d: 'Cable-together', h: 1, on: 1 },
    { k: 'cap', n: 'Each group fits in one cabinet', d: 'Cabinet capacity', h: 1, on: 1 },
  ],
  hw: {
    AI: ['CHARM AI 4-20 mA', '2-wire TB'], AO: ['CHARM AO 4-20 mA', '2-wire TB'], DI: ['CHARM DI 24 VDC', 'Dry contact TB'],
    DO: ['CHARM DO 24 VDC', 'Std TB'], DOI: ['CHARM DO isolated', 'Fused TB'],
  },
};

module.exports = { defaults };
