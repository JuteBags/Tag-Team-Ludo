//! AVX2 versions of jsmath functions, bit-identical lane by lane: the same fdlibm operations (IEEE
//! add/sub/mul/div are correctly rounded in AVX2 exactly as in scalar code, and nothing is fused), every
//! branch computed and the right one selected per lane. Checked against the scalar code by jsmath-check.
#![cfg(target_arch = "x86_64")]
use crate::jsmath::tanh;
use std::arch::x86_64::*;

/// tanh of 4 numbers. Lanes outside the common range (|x| < 2^-28, NaN, inf) send the whole vector to
/// the scalar path. For 2^-28 <= |x| < 1 tanh calls expm1(-2|x|), for 1 <= |x| < 22 expm1(2|x|), which
/// only reaches expm1's k = 0, k = -1, k <= -2, 3 <= k < 20, 20 <= k <= 56 and k > 56 cases.
#[target_feature(enable = "avx2")]
pub unsafe fn tanh4(v: &mut [f64; 4]) {
    let x = _mm256_loadu_pd(v.as_ptr());
    let bits = _mm256_castpd_si256(x);
    let ix = _mm256_and_si256(_mm256_srli_epi64(bits, 32), _mm256_set1_epi64x(0x7FFF_FFFF));
    let tiny = _mm256_cmpgt_epi64(_mm256_set1_epi64x(0x3E30_0000), ix);
    let naninf = _mm256_cmpgt_epi64(ix, _mm256_set1_epi64x(0x7FEF_FFFF));
    if _mm256_movemask_pd(_mm256_castsi256_pd(_mm256_or_si256(tiny, naninf))) != 0 {
        for t in v.iter_mut() {
            *t = tanh(*t);
        }
        return;
    }
    let absx = _mm256_andnot_pd(_mm256_set1_pd(-0.0), x);
    let big = _mm256_castsi256_pd(_mm256_cmpgt_epi64(ix, _mm256_set1_epi64x(0x3FEF_FFFF))); // |x| >= 1
    let huge = _mm256_castsi256_pd(_mm256_cmpgt_epi64(ix, _mm256_set1_epi64x(0x4035_FFFF))); // |x| >= 22
    let two = _mm256_set1_pd(2.0);
    let one = _mm256_set1_pd(1.0);
    // fdlibm: expm1(two*fabs(x)) / expm1(-two*fabs(x))
    let y = _mm256_blendv_pd(_mm256_mul_pd(_mm256_set1_pd(-2.0), absx), _mm256_mul_pd(two, absx), big);
    let t = expm1_4(y);
    let z_big = _mm256_sub_pd(one, _mm256_div_pd(two, _mm256_add_pd(t, two)));
    // -t / (t + two): negation is exact
    let z_small = _mm256_div_pd(_mm256_xor_pd(t, _mm256_set1_pd(-0.0)), _mm256_add_pd(t, two));
    let mut z = _mm256_blendv_pd(z_small, z_big, big);
    z = _mm256_blendv_pd(z, _mm256_sub_pd(one, _mm256_set1_pd(1.0e-300)), huge);
    let neg = _mm256_castsi256_pd(_mm256_cmpgt_epi64(_mm256_setzero_si256(), bits));
    z = _mm256_blendv_pd(z, _mm256_xor_pd(z, _mm256_set1_pd(-0.0)), neg);
    _mm256_storeu_pd(v.as_mut_ptr(), z);
}

/// expm1 for the arguments tanh4 passes (2^-27 <= |y| < 44, finite).
#[target_feature(enable = "avx2")]
unsafe fn expm1_4(y: __m256d) -> __m256d {
    const LN2_HI: f64 = 6.93147180369123816490e-01;
    const LN2_LO: f64 = 1.90821492927058770002e-10;
    const INVLN2: f64 = 1.44269504088896338700e+00;
    const Q1: f64 = -3.33333333333331316428e-02;
    const Q2: f64 = 1.58730158725481460165e-03;
    const Q3: f64 = -7.93650757867487942473e-05;
    const Q4: f64 = 4.00821782732936239552e-06;
    const Q5: f64 = -2.01099218183624371326e-07;
    let bits = _mm256_castpd_si256(y);
    let hx = _mm256_and_si256(_mm256_srli_epi64(bits, 32), _mm256_set1_epi64x(0x7FFF_FFFF));
    let neg_i = _mm256_cmpgt_epi64(_mm256_setzero_si256(), bits);
    let neg = _mm256_castsi256_pd(neg_i);
    let gt_half_i = _mm256_cmpgt_epi64(hx, _mm256_set1_epi64x(0x3FD6_2E42)); // |y| > 0.5 ln2
    let lt_15_i = _mm256_cmpgt_epi64(_mm256_set1_epi64x(0x3FF0_A2B2), hx); // |y| < 1.5 ln2
    let band_i = _mm256_and_si256(gt_half_i, lt_15_i);
    let gt_half = _mm256_castsi256_pd(gt_half_i);
    let band = _mm256_castsi256_pd(band_i);
    // k = (int)(invln2*y + (y >= 0 ? 0.5 : -0.5)), C truncation
    let half = _mm256_blendv_pd(_mm256_set1_pd(0.5), _mm256_set1_pd(-0.5), neg);
    let kr = _mm256_cvtepi32_epi64(_mm256_cvttpd_epi32(_mm256_add_pd(_mm256_mul_pd(_mm256_set1_pd(INVLN2), y), half)));
    // band: k = +1 / -1 by sign (neg_i is all ones = -1 where negative)
    let k1 = _mm256_or_si256(neg_i, _mm256_set1_epi64x(1));
    let mut k = _mm256_blendv_epi8(kr, k1, band_i);
    k = _mm256_and_si256(k, gt_half_i); // k = 0 when |y| <= 0.5 ln2
    let kd = _mm256_cvtepi32_pd(_mm256_castsi256_si128(_mm256_permutevar8x32_epi32(k, _mm256_setr_epi32(0, 2, 4, 6, 0, 2, 4, 6))));
    let hi_band = _mm256_blendv_pd(_mm256_sub_pd(y, _mm256_set1_pd(LN2_HI)), _mm256_add_pd(y, _mm256_set1_pd(LN2_HI)), neg);
    let lo_band = _mm256_blendv_pd(_mm256_set1_pd(LN2_LO), _mm256_set1_pd(-LN2_LO), neg);
    let hi_r = _mm256_sub_pd(y, _mm256_mul_pd(kd, _mm256_set1_pd(LN2_HI)));
    let lo_r = _mm256_mul_pd(kd, _mm256_set1_pd(LN2_LO));
    let hi = _mm256_blendv_pd(hi_r, hi_band, band);
    let lo = _mm256_blendv_pd(lo_r, lo_band, band);
    let xr = _mm256_sub_pd(hi, lo);
    let cr = _mm256_sub_pd(_mm256_sub_pd(hi, xr), lo);
    let xx = _mm256_blendv_pd(y, xr, gt_half);
    let c = _mm256_blendv_pd(_mm256_setzero_pd(), cr, gt_half);
    let hfx = _mm256_mul_pd(_mm256_set1_pd(0.5), xx);
    let hxs = _mm256_mul_pd(xx, hfx);
    // one + hxs*(Q1 + hxs*(Q2 + hxs*(Q3 + hxs*(Q4 + hxs*Q5))))
    let mut p = _mm256_add_pd(_mm256_set1_pd(Q4), _mm256_mul_pd(hxs, _mm256_set1_pd(Q5)));
    p = _mm256_add_pd(_mm256_set1_pd(Q3), _mm256_mul_pd(hxs, p));
    p = _mm256_add_pd(_mm256_set1_pd(Q2), _mm256_mul_pd(hxs, p));
    p = _mm256_add_pd(_mm256_set1_pd(Q1), _mm256_mul_pd(hxs, p));
    let one = _mm256_set1_pd(1.0);
    let r1 = _mm256_add_pd(one, _mm256_mul_pd(hxs, p));
    let t = _mm256_sub_pd(_mm256_set1_pd(3.0), _mm256_mul_pd(r1, hfx));
    let e0 = _mm256_mul_pd(hxs, _mm256_div_pd(_mm256_sub_pd(r1, t), _mm256_sub_pd(_mm256_set1_pd(6.0), _mm256_mul_pd(xx, t))));
    let res_k0 = _mm256_sub_pd(xx, _mm256_sub_pd(_mm256_mul_pd(xx, e0), hxs));
    let e1 = _mm256_sub_pd(_mm256_sub_pd(_mm256_mul_pd(xx, _mm256_sub_pd(e0, c)), c), hxs);
    let twopk = _mm256_castsi256_pd(_mm256_slli_epi64(_mm256_add_epi64(k, _mm256_set1_epi64x(0x3FF)), 52));
    let twomk = _mm256_castsi256_pd(_mm256_slli_epi64(_mm256_sub_epi64(_mm256_set1_epi64x(0x3FF), k), 52));
    let res_km1 = _mm256_sub_pd(_mm256_mul_pd(_mm256_set1_pd(0.5), _mm256_sub_pd(xx, e1)), _mm256_set1_pd(0.5));
    let res_far = _mm256_sub_pd(_mm256_mul_pd(_mm256_sub_pd(one, _mm256_sub_pd(e1, xx)), twopk), one);
    let res_lt20 = _mm256_mul_pd(_mm256_sub_pd(_mm256_sub_pd(one, twomk), _mm256_sub_pd(e1, xx)), twopk);
    let res_ge20 = _mm256_mul_pd(_mm256_add_pd(_mm256_sub_pd(xx, _mm256_add_pd(e1, twomk)), one), twopk);
    let k0 = _mm256_castsi256_pd(_mm256_cmpeq_epi64(k, _mm256_setzero_si256()));
    let km1 = _mm256_castsi256_pd(_mm256_cmpeq_epi64(k, _mm256_set1_epi64x(-1)));
    let far = _mm256_castsi256_pd(_mm256_or_si256(_mm256_cmpgt_epi64(_mm256_set1_epi64x(-1), k), _mm256_cmpgt_epi64(k, _mm256_set1_epi64x(56))));
    let lt20 = _mm256_castsi256_pd(_mm256_cmpgt_epi64(_mm256_set1_epi64x(20), k));
    let mut r = res_ge20;
    r = _mm256_blendv_pd(r, res_lt20, lt20);
    r = _mm256_blendv_pd(r, res_far, far);
    r = _mm256_blendv_pd(r, res_km1, km1);
    r = _mm256_blendv_pd(r, res_k0, k0);
    r
}
