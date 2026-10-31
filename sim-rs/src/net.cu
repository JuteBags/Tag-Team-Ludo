// The value net (net.ts / eval.rs Net) on the GPU, f64, one block per position. Compiled by NVRTC with
// --fmad=false, so every a * b + c rounds twice, as in V8 and eval.rs; each output row sums
// b[r] + w[r][c] a[c] over c in increasing order, like the TypeScript. Zero inputs are skipped (eval.rs
// Dense::apply_batch explains why that cannot change a non-zero result). tanh, expm1, Math.max and
// Math.min are jsmath.rs transcribed, so the scores are bit-identical to the CPU's.
#define MAXW 384
#define MAXC 4

__device__ __forceinline__ unsigned int hiw(double x) { return (unsigned int)(__double_as_longlong(x) >> 32); }
__device__ __forceinline__ unsigned int low(double x) { return (unsigned int)(__double_as_longlong(x)); }
__device__ __forceinline__ double words(unsigned int h, unsigned int l) {
  return __longlong_as_double((long long)(((unsigned long long)h << 32) | (unsigned long long)l));
}

// ieee754::expm1 (FreeBSD s_expm1.c), as jsmath::expm1.
__device__ double js_expm1(double x) {
  const double one = 1.0, tiny = 1.0e-300, huge = 1.0e+300;
  const double o_threshold = 7.09782712893383973096e+02;
  const double ln2_hi = 6.93147180369123816490e-01, ln2_lo = 1.90821492927058770002e-10;
  const double invln2 = 1.44269504088896338700e+00;
  const double Q1 = -3.33333333333331316428e-02, Q2 = 1.58730158725481460165e-03,
               Q3 = -7.93650757867487942473e-05, Q4 = 4.00821782732936239552e-06,
               Q5 = -2.01099218183624371326e-07;
  unsigned int hx = hiw(x);
  unsigned int xsb = hx & 0x80000000u;
  hx &= 0x7fffffffu;
  if (hx >= 0x4043687Au) {
    if (hx >= 0x40862E42u) {
      if (hx >= 0x7ff00000u) {
        if (((hx & 0xfffffu) | low(x)) != 0) return x + x;
        return xsb == 0 ? x : -1.0;
      }
      if (x > o_threshold) return huge * huge;
    }
    if (xsb != 0 && x + tiny < 0.0) return tiny - one;
  }
  int k;
  double c = 0.0;
  if (hx > 0x3FD62E42u) {
    double hi_, lo_;
    if (hx < 0x3FF0A2B2u) {
      if (xsb == 0) { hi_ = x - ln2_hi; lo_ = ln2_lo; k = 1; }
      else { hi_ = x + ln2_hi; lo_ = -ln2_lo; k = -1; }
    } else {
      k = (int)(invln2 * x + (xsb == 0 ? 0.5 : -0.5));
      double t = (double)k;
      hi_ = x - t * ln2_hi;
      lo_ = t * ln2_lo;
    }
    x = hi_ - lo_;
    c = (hi_ - x) - lo_;
  } else if (hx < 0x3C900000u) {
    double t = huge + x;
    return x - (t - (huge + x));
  } else {
    k = 0;
  }
  double hfx = 0.5 * x;
  double hxs = x * hfx;
  double r1 = one + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
  double t = 3.0 - r1 * hfx;
  double e = hxs * ((r1 - t) / (6.0 - x * t));
  if (k == 0) return x - (x * e - hxs);
  double twopk = words((unsigned int)(0x3FF00000 + (k << 20)), 0);
  e = x * (e - c) - c;
  e -= hxs;
  if (k == -1) return 0.5 * (x - e) - 0.5;
  if (k == 1) {
    if (x < -0.25) return -2.0 * (e - (x + 0.5));
    return one + 2.0 * (x - e);
  }
  if (k <= -2 || k > 56) {
    double y = one - (e - x);
    if (k == 1024) y = y * 2.0 * 8.98846567431158e+307;
    else y *= twopk;
    return y - one;
  }
  double y;
  t = one;
  if (k < 20) {
    t = words(0x3FF00000u - (0x200000u >> k), low(t));
    y = t - (e - x);
    y *= twopk;
  } else {
    t = words((unsigned int)((0x3FF - k) << 20), low(t));
    y = x - (e + t);
    y += one;
    y *= twopk;
  }
  return y;
}

// ieee754::tanh (FreeBSD s_tanh.c), as jsmath::tanh.
__device__ double js_tanh(double x) {
  const double one = 1.0, two = 2.0, tiny = 1.0e-300, huge = 1.0e300;
  int jx = (int)hiw(x);
  int ix = jx & 0x7FFFFFFF;
  if (ix >= 0x7FF00000) return jx >= 0 ? one / x + one : one / x - one;
  double z;
  if (ix < 0x40360000) {
    if (ix < 0x3E300000 && huge + x > one) return x;
    if (ix >= 0x3FF00000) {
      double t = js_expm1(two * fabs(x));
      z = one - two / (t + two);
    } else {
      double t = js_expm1(-two * fabs(x));
      z = -t / (t + two);
    }
  } else {
    z = one - tiny;
  }
  return jx >= 0 ? z : -z;
}

__device__ __forceinline__ double js_max(double a, double b) {
  if (isnan(a) || isnan(b)) return __longlong_as_double(0x7ff8000000000000LL);
  if (a > b) return a;
  if (b > a) return b;
  if (a == 0.0 && b == 0.0) return (!signbit(a) || !signbit(b)) ? 0.0 : -0.0;
  return a;
}

__device__ __forceinline__ double js_min(double a, double b) {
  if (isnan(a) || isnan(b)) return __longlong_as_double(0x7ff8000000000000LL);
  if (a < b) return a;
  if (b < a) return b;
  if (a == 0.0 && b == 0.0) return (signbit(a) || signbit(b)) ? -0.0 : 0.0;
  return a;
}

// One dense layer over nb vectors held in shared memory: z[j][r] = act(b[r] + sum_c w[c][r] a[j][c]).
__device__ void dense(const double* __restrict__ W, const int* L, const double (*a)[MAXW], double (*z)[MAXW], int nb, bool act) {
  const int inn = L[0], out = L[1];
  const double* wt = W + L[2];
  const double* b = W + L[3];
  for (int r = threadIdx.x; r < out; r += blockDim.x) {
    for (int j = 0; j < nb; j++) {
      double s = b[r];
      for (int c = 0; c < inn; c++) {
        double v = a[j][c];
        if (v != 0.0) s = s + wt[c * out + r] * v;
      }
      z[j][r] = act ? js_tanh(s) : s;
    }
  }
  __syncthreads();
}

// layers: [inn, out, w offset, b offset] per layer: ntrunk trunk layers, then pool, then out.
// meta per position: n colours, people, owner of colour 0..3. Colour i of position p has its non-zero
// inputs at idx/val[start[p*4+i] .. start[p*4+i+1]) (trunk input index, value), increasing index.
// scores: per position, 4 doubles, the head's score by owner (NaN for a person with no colour).
extern "C" __global__ void net_scores(const double* __restrict__ W, const int* __restrict__ layers, int ntrunk,
                                      const int* __restrict__ meta, const int* __restrict__ start,
                                      const int* __restrict__ idx, const double* __restrict__ val,
                                      double* __restrict__ scores, int npos) {
  __shared__ double A[MAXC][MAXW];
  __shared__ double Z[MAXC][MAXW];
  __shared__ int who[MAXC];
  __shared__ int np;
  const int p = blockIdx.x;
  if (p >= npos) return;
  const int n = meta[p * 6], people = meta[p * 6 + 1];
  const int* owner = meta + p * 6 + 2;

  // first trunk layer from the sparse inputs
  {
    const int* L = layers;
    const int out = L[1];
    const double* wt = W + L[2];
    const double* b = W + L[3];
    for (int r = threadIdx.x; r < out; r += blockDim.x) {
      for (int i = 0; i < n; i++) {
        double s = b[r];
        for (int q = start[p * 4 + i]; q < start[p * 4 + i + 1]; q++) s = s + wt[idx[q] * out + r] * val[q];
        Z[i][r] = js_tanh(s);
      }
    }
    __syncthreads();
  }
  double(*a)[MAXW] = Z;
  double(*z)[MAXW] = A;
  for (int l = 1; l < ntrunk; l++) {
    dense(W, layers + 4 * l, a, z, n, true);
    double(*t)[MAXW] = a;
    a = z;
    z = t;
  }
  const int h = layers[4 * (ntrunk - 1) + 1];
  // pool each person's colours in colour order: sum, max, min
  if (threadIdx.x == 0) {
    int m = 0;
    for (int o = 0; o < people; o++) {
      bool any = false;
      for (int i = 0; i < n; i++) any = any || owner[i] == o;
      if (any) who[m++] = o;
    }
    np = m;
  }
  __syncthreads();
  for (int k = threadIdx.x; k < h; k += blockDim.x) {
    for (int j = 0; j < np; j++) {
      int o = who[j];
      int count = 0;
      double sum = 0.0, mx = 0.0, mn = 0.0;
      for (int i = 0; i < n; i++) {
        if (owner[i] != o) continue;
        double v = a[i][k];
        if (count == 0) { sum = v; mx = v; mn = v; }
        else { sum = sum + v; mx = js_max(mx, v); mn = js_min(mn, v); }
        count++;
      }
      z[j][k] = sum;
      z[j][h + k] = mx;
      z[j][2 * h + k] = mn;
    }
  }
  __syncthreads();
  dense(W, layers + 4 * ntrunk, z, a, np, true);
  dense(W, layers + 4 * (ntrunk + 1), a, z, np, false);
  if (threadIdx.x == 0) {
    double nan = __longlong_as_double(0x7ff8000000000000LL);
    for (int o = 0; o < 4; o++) scores[p * 4 + o] = nan;
    for (int j = 0; j < np; j++) scores[p * 4 + who[j]] = z[j][0];
  }
}
