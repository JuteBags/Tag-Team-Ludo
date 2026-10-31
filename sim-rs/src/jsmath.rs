//! Math.exp, Math.tanh, Math.max and Math.min exactly as V8 computes them, so net and linear-rule
//! evaluations match the TypeScript to the last bit. V8 does not call the platform libm for these: it
//! carries its own port of FreeBSD msun (v8/src/base/ieee754.cc). This is that code, transcribed.
//! No FMA contraction: Rust never fuses a*b+c on its own.

#[inline]
fn hi(x: f64) -> u32 {
    (x.to_bits() >> 32) as u32
}
#[inline]
fn lo(x: f64) -> u32 {
    x.to_bits() as u32
}
#[inline]
fn from_words(h: u32, l: u32) -> f64 {
    f64::from_bits(((h as u64) << 32) | l as u64)
}
#[inline]
fn set_high(x: f64, h: u32) -> f64 {
    from_words(h, lo(x))
}

/// ieee754::exp (FreeBSD e_exp.c, with V8's exp(1) = E special case).
pub fn exp(mut x: f64) -> f64 {
    const ONE: f64 = 1.0;
    const HALF: [f64; 2] = [0.5, -0.5];
    const O_THRESHOLD: f64 = 7.09782712893383973096e+02;
    const U_THRESHOLD: f64 = -7.45133219101941108420e+02;
    const LN2HI: [f64; 2] = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
    const LN2LO: [f64; 2] = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
    const INVLN2: f64 = 1.44269504088896338700e+00;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    const E: f64 = 2.718281828459045;
    const HUGE: f64 = 1.0e+300;
    const TWOM1000: f64 = 9.33263618503218878990e-302;
    const TWO1023: f64 = 8.988465674311579539e307;

    let (mut hi_, mut lo_) = (0.0f64, 0.0f64);
    let mut k: i32 = 0;
    let mut hx = hi(x);
    let xsb = ((hx >> 31) & 1) as usize;
    hx &= 0x7fff_ffff;
    if hx >= 0x4086_2E42 {
        if hx >= 0x7ff0_0000 {
            if ((hx & 0xfffff) | lo(x)) != 0 {
                return x + x;
            }
            return if xsb == 0 { x } else { 0.0 };
        }
        if x > O_THRESHOLD {
            return HUGE * HUGE;
        }
        if x < U_THRESHOLD {
            return TWOM1000 * TWOM1000;
        }
    }
    if hx > 0x3FD6_2E42 {
        if hx < 0x3FF0_A2B2 {
            if x == 1.0 {
                return E;
            }
            hi_ = x - LN2HI[xsb];
            lo_ = LN2LO[xsb];
            k = 1 - xsb as i32 - xsb as i32;
        } else {
            k = (INVLN2 * x + HALF[xsb]) as i32;
            let t = k as f64;
            hi_ = x - t * LN2HI[0];
            lo_ = t * LN2LO[0];
        }
        x = hi_ - lo_;
    } else if hx < 0x3E30_0000 {
        if HUGE + x > ONE {
            return ONE + x;
        }
    } else {
        k = 0;
    }
    let t = x * x;
    let twopk = if k >= -1021 { from_words((0x3FF0_0000i32 + (k << 20)) as u32, 0) } else { from_words((0x3FF0_0000i32 + ((k + 1000) << 20)) as u32, 0) };
    let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0 {
        return ONE - ((x * c) / (c - 2.0) - x);
    }
    let y = ONE - ((lo_ - (x * c) / (2.0 - c)) - hi_);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * TWO1023;
        }
        y * twopk
    } else {
        y * twopk * TWOM1000
    }
}

/// ieee754::expm1 (FreeBSD s_expm1.c).
pub fn expm1(mut x: f64) -> f64 {
    const ONE: f64 = 1.0;
    const TINY: f64 = 1.0e-300;
    const HUGE: f64 = 1.0e+300;
    const O_THRESHOLD: f64 = 7.09782712893383973096e+02;
    const LN2_HI: f64 = 6.93147180369123816490e-01;
    const LN2_LO: f64 = 1.90821492927058770002e-10;
    const INVLN2: f64 = 1.44269504088896338700e+00;
    const Q1: f64 = -3.33333333333331316428e-02;
    const Q2: f64 = 1.58730158725481460165e-03;
    const Q3: f64 = -7.93650757867487942473e-05;
    const Q4: f64 = 4.00821782732936239552e-06;
    const Q5: f64 = -2.01099218183624371326e-07;

    let mut hx = hi(x);
    let xsb = hx & 0x8000_0000;
    hx &= 0x7fff_ffff;
    if hx >= 0x4043_687A {
        if hx >= 0x4086_2E42 {
            if hx >= 0x7ff0_0000 {
                if ((hx & 0xfffff) | lo(x)) != 0 {
                    return x + x;
                }
                return if xsb == 0 { x } else { -1.0 };
            }
            if x > O_THRESHOLD {
                return HUGE * HUGE;
            }
        }
        if xsb != 0 && x + TINY < 0.0 {
            return TINY - ONE;
        }
    }
    let k: i32;
    let mut c = 0.0f64;
    if hx > 0x3FD6_2E42 {
        let (hi_, lo_);
        if hx < 0x3FF0_A2B2 {
            if xsb == 0 {
                hi_ = x - LN2_HI;
                lo_ = LN2_LO;
                k = 1;
            } else {
                hi_ = x + LN2_HI;
                lo_ = -LN2_LO;
                k = -1;
            }
        } else {
            k = (INVLN2 * x + if xsb == 0 { 0.5 } else { -0.5 }) as i32;
            let t = k as f64;
            hi_ = x - t * LN2_HI;
            lo_ = t * LN2_LO;
        }
        x = hi_ - lo_;
        c = (hi_ - x) - lo_;
    } else if hx < 0x3C90_0000 {
        let t = HUGE + x;
        return x - (t - (HUGE + x));
    } else {
        k = 0;
    }
    let hfx = 0.5 * x;
    let hxs = x * hfx;
    let r1 = ONE + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
    let mut t = 3.0 - r1 * hfx;
    let mut e = hxs * ((r1 - t) / (6.0 - x * t));
    if k == 0 {
        return x - (x * e - hxs);
    }
    let twopk = from_words((0x3FF0_0000i32 + (k << 20)) as u32, 0);
    e = x * (e - c) - c;
    e -= hxs;
    if k == -1 {
        return 0.5 * (x - e) - 0.5;
    }
    if k == 1 {
        if x < -0.25 {
            return -2.0 * (e - (x + 0.5));
        }
        return ONE + 2.0 * (x - e);
    }
    if k <= -2 || k > 56 {
        let mut y = ONE - (e - x);
        if k == 1024 {
            y = y * 2.0 * 8.98846567431158e+307;
        } else {
            y *= twopk;
        }
        return y - ONE;
    }
    let mut y;
    t = ONE;
    if k < 20 {
        t = set_high(t, 0x3FF0_0000 - (0x20_0000 >> k));
        y = t - (e - x);
        y *= twopk;
    } else {
        t = set_high(t, ((0x3FF - k) << 20) as u32);
        y = x - (e + t);
        y += ONE;
        y *= twopk;
    }
    y
}

/// ieee754::tanh (FreeBSD s_tanh.c).
pub fn tanh(x: f64) -> f64 {
    const ONE: f64 = 1.0;
    const TWO: f64 = 2.0;
    const TINY: f64 = 1.0e-300;
    const HUGE: f64 = 1.0e300;
    let jx = hi(x) as i32;
    let ix = jx & 0x7FFF_FFFF;
    if ix >= 0x7FF0_0000 {
        return if jx >= 0 { ONE / x + ONE } else { ONE / x - ONE };
    }
    let z;
    if ix < 0x4036_0000 {
        if ix < 0x3E30_0000 && HUGE + x > ONE {
            return x;
        }
        if ix >= 0x3FF0_0000 {
            let t = expm1(TWO * x.abs());
            z = ONE - TWO / (t + TWO);
        } else {
            let t = expm1(-TWO * x.abs());
            z = -t / (t + TWO);
        }
    } else {
        z = ONE - TINY;
    }
    if jx >= 0 {
        z
    } else {
        -z
    }
}

/// Math.max for two numbers: NaN wins, and +0 beats -0.
#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b {
        a
    } else if b > a {
        b
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() || b.is_sign_positive() {
            0.0
        } else {
            -0.0
        }
    } else {
        a
    }
}

/// Math.min for two numbers: NaN wins, and -0 beats +0.
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b {
        a
    } else if b < a {
        b
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() || b.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else {
        a
    }
}
