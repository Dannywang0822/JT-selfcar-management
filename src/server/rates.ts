/**
 * 已确认的调整幅度：相对上一季度，92 号汽油每变化 0.50 元/升，补贴同向调整 0.05 元/公里，不足不调。
 * 基准油价、基准费率、取整方式在规则版本里配置。演示库使用向零取整，并标明非正式政策。
 */
export type RateInput = {
  baselineRateFenPerKm: number;
  previousPriceFenPerLiter: number;
  currentPriceFenPerLiter: number;
  thresholdFen: number;
  stepFenPerKm: number;
};

export type RateResult = {
  rateFenPerKm: number;
  steps: number;
  deltaFen: number;
  rounding: "toward_zero";
};

export function adjustedRate(input: RateInput): RateResult {
  if (input.thresholdFen <= 0) {
    throw new Error("油价调整阈值必须大于 0");
  }
  const deltaFen = input.currentPriceFenPerLiter - input.previousPriceFenPerLiter;
  const steps = Math.trunc(deltaFen / input.thresholdFen) || 0;
  return {
    rateFenPerKm: input.baselineRateFenPerKm + steps * input.stepFenPerKm,
    steps,
    deltaFen,
    rounding: "toward_zero",
  };
}
