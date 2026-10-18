// Die casting's failure-mode models (T8.02 to T8.04): the browser's twins of the API's
// api/src/tiles_api/models/failure_modes.py. test/fixtures/failure-models.json, made from these,
// keeps the two giving the same numbers.
//
// - Shot accumulator charge: the precharge the charged pressure implies by the gas law, and the
//   pressure build-up time the orifice law expects at that pressure; the rest is the sag.
// - Holding furnace heater: the power the bath needs while the cell casts, by a heat balance
//   linearised about the set point; an ageing element draws more.
// - Die cooling, moving half: the flow the channel lost and how much hotter the moving half runs
//   than the fixed half; its blockage beyond a limit is a physics threshold.

import { median } from './stats.ts';

export type Series = (number | null)[];
export type ModelOutputs = Record<string, Series>;

function medianOf(values: Series): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? median(known) : null;
}

export const ACCUMULATOR = {
  rated_pressure: 160, // bar, a healthy accumulator charged
  rated_buildup: 24, // ms, a healthy accumulator's build-up time
  load_pressure: 60, // bar, what the intensifier needs to move
  fill: 0.3, // the oil the pump puts in, as a share of the gas volume
  polytropic: 1.4, // the nitrogen's polytropic exponent
};

export function accumulatorCharge(
  inputs: { buildup: readonly number[]; pressure: readonly number[] },
  p = ACCUMULATOR,
): ModelOutputs {
  const ratio = (1 - p.fill) ** p.polytropic;
  const precharge: Series = [];
  const expected: Series = [];
  const excess: Series = [];
  inputs.buildup.forEach((b, i) => {
    const pressure = inputs.pressure[i]!;
    precharge.push(pressure * ratio);
    if (pressure <= p.load_pressure) {
      expected.push(null); // too little pressure to build at all: nothing to expect
      excess.push(null);
      return;
    }
    const e = p.rated_buildup * Math.sqrt((p.rated_pressure - p.load_pressure) / (pressure - p.load_pressure));
    expected.push(e);
    excess.push(b - e);
  });
  const p0 = medianOf(precharge);
  return {
    precharge,
    expected_buildup: expected,
    excess_buildup: excess,
    charge_loss: [p0 === null ? null : 1 - p0 / (p.rated_pressure * ratio)],
    sag: [medianOf(excess)],
  };
}

export const FURNACE = {
  set_point: 690, // °C
  holding_power: 34, // kW to hold the bath at its set point, the cell idle
  casting_power: 14, // kW the casting adds
  loss_slope: 0.34, // kW per kelvin of bath temperature
  max_cycle: 300, // s: a longer cycle is the cell waiting
};

export function furnaceHeater(
  inputs: { power: readonly number[]; bath: readonly number[]; cycle: readonly number[] },
  p = FURNACE,
): ModelOutputs {
  const base = p.holding_power + p.casting_power;
  const demand: Series = [];
  const excess: Series = [];
  const deficit: Series = [];
  inputs.power.forEach((power, i) => {
    const bath = inputs.bath[i]!;
    const cycle = inputs.cycle[i]!;
    if (cycle > p.max_cycle || cycle <= 0) {
      demand.push(null);
      excess.push(null);
      deficit.push(null);
      return;
    }
    const d = base + p.loss_slope * (bath - p.set_point);
    demand.push(d);
    excess.push(power - d);
    deficit.push(p.set_point - bath);
  });
  return { demand, excess, heater_excess: [medianOf(excess)], bath_deficit: [medianOf(deficit)] };
}

export const COOLING = {
  rated_flow: 42, // l/min, a clean channel
  exponent: 0.8, // heat transfer per flow (Dittus-Boelter)
  design_gap: 4, // °C the moving half runs hotter by design
  limit: 0.2, // the flow lost at which the moving half runs too hot
};

export function dieCooling(
  inputs: { die_temp: readonly number[]; fixed_temp: readonly number[]; flow: readonly number[] },
  p = COOLING,
): ModelOutputs {
  const loss: Series = [];
  const transfer: Series = [];
  const gap: Series = [];
  inputs.die_temp.forEach((moving, i) => {
    const share = Math.max(0, inputs.flow[i]!) / p.rated_flow;
    loss.push(1 - share);
    transfer.push(share ** p.exponent);
    gap.push(moving - inputs.fixed_temp[i]! - p.design_gap);
  });
  const blockage = medianOf(loss);
  return {
    flow_loss: loss,
    heat_transfer: transfer,
    half_gap: gap,
    blockage: [blockage],
    hot_half: [medianOf(gap)],
    over_limit: [blockage === null ? null : Math.max(0, blockage - p.limit)],
  };
}
