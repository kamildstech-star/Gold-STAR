/**
 * Psychrometrics for the drying log.
 *
 * A crew reads two numbers off a thermo-hygrometer: temperature and relative
 * humidity. Dew point and grains per pound are calculated from those, never
 * typed — a hand-copied dew point is a number nobody can re-derive, and dew
 * point is precisely the figure a carrier argues about when it refuses to pay
 * for equipment days.
 *
 * Relative humidity alone proves nothing, which is why this file exists: 60% RH
 * at 90 °F carries ~128 grains of water per pound of dry air, 60% RH at 60 °F
 * carries ~46. Only dew point and GPP show water actually leaving a structure.
 *
 * Fahrenheit is canonical throughout — Gold Star is a US company and the paper
 * form is in Fahrenheit. Celsius appears only inside these functions, because
 * the published constants are defined for it.
 */

/** Saturation vapour pressure at 0 °C, hPa. */
const ES0_HPA = 6.112;

/**
 * Magnus-form coefficients from Alduchov & Eskridge (1996), "Improved Magnus
 * Form Approximation of Saturation Vapor Pressure", Journal of Applied
 * Meteorology 35(4):601-609. Maximum relative error 0.384% for saturation
 * vapour pressure over water across -40..+50 °C, which covers every structure
 * anyone dries.
 */
const MAGNUS_B = 17.625;
const MAGNUS_C = 243.04;

/**
 * Ratio of the molar masses of water vapour and dry air (18.015 / 28.966).
 * ASHRAE Handbook — Fundamentals, ch. 1.
 */
const MW_RATIO = 0.621945;

/** Standard sea-level atmospheric pressure, hPa. */
const STANDARD_PRESSURE_HPA = 1013.25;

/** Grains in a pound. The trade reports humidity ratio in grains, not pounds. */
const GRAINS_PER_LB = 7000;

function fToC(f: number): number {
  return ((f - 32) * 5) / 9;
}

function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

/**
 * A reading is only usable if both numbers are real and RH is a percentage
 * above zero. RH of exactly 0 has no finite dew point (ln 0), and a meter
 * never actually reports it, so it is rejected rather than clamped.
 */
export function isUsableReading(tempF: number | null, rhPct: number | null): boolean {
  return (
    tempF != null &&
    rhPct != null &&
    Number.isFinite(tempF) &&
    Number.isFinite(rhPct) &&
    rhPct > 0 &&
    rhPct <= 100
  );
}

/** Saturation vapour pressure over liquid water, hPa, for a Celsius temperature. */
function saturationVapourPressureHpa(tempC: number): number {
  return ES0_HPA * Math.exp((MAGNUS_B * tempC) / (MAGNUS_C + tempC));
}

/**
 * Dew point in °F, or null when the inputs cannot produce one.
 *
 * At 100% RH this returns the dry-bulb temperature exactly (the gamma term
 * collapses), which is the identity the test suite pins.
 */
export function dewPointF(tempF: number | null, rhPct: number | null): number | null {
  if (!isUsableReading(tempF, rhPct)) return null;
  const tempC = fToC(tempF!);
  const gamma = Math.log(rhPct! / 100) + (MAGNUS_B * tempC) / (MAGNUS_C + tempC);
  return cToF((MAGNUS_C * gamma) / (MAGNUS_B - gamma));
}

/**
 * Humidity ratio in grains of water vapour per pound of dry air.
 *
 * Sea-level pressure is assumed. Gold Star works the New York metro, where the
 * correction is under a grain; taking a barometric pressure per reading would
 * be a field where the crew guesses, and a guess is worse than a constant.
 */
export function grainsPerPound(tempF: number | null, rhPct: number | null): number | null {
  if (!isUsableReading(tempF, rhPct)) return null;
  const tempC = fToC(tempF!);
  const vapourPressure = saturationVapourPressureHpa(tempC) * (rhPct! / 100);
  // Above the boiling point the ratio diverges; nothing dryable is that hot.
  if (vapourPressure >= STANDARD_PRESSURE_HPA) return null;
  const humidityRatio = (MW_RATIO * vapourPressure) / (STANDARD_PRESSURE_HPA - vapourPressure);
  return humidityRatio * GRAINS_PER_LB;
}

/** Both derived figures at once, rounded the way they are printed and stored. */
export function derive(
  tempF: number | null,
  rhPct: number | null,
): { dewPointF: number | null; gpp: number | null } {
  const dp = dewPointF(tempF, rhPct);
  const gpp = grainsPerPound(tempF, rhPct);
  return {
    dewPointF: dp == null ? null : Math.round(dp * 10) / 10,
    gpp: gpp == null ? null : Math.round(gpp * 10) / 10,
  };
}
