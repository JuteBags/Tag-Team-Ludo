// Rollout playouts on the GPU, one thread per playout: rollout.rs playout() with every seat played by a
// readable-rules search policy (net:<linear.json>:1:<theirK>:0:0:<chance>, i.e. search.rs at depth 1,
// temperature 0, no race database, no probe cut). Bit-identical to the CPU: the same rules (rules.rs,
// game.rs), the same rng draws in the same order (rng.rs, dice.rs, search.rs pick), and the same f64
// operations in the same order (encode.rs features, eval.rs owner_scores / chances_from_scores, jsmath
// exp), compiled by NVRTC with --fmad=false. The search's memo and leaf caches only reuse values the
// search would compute again, so dropping them changes the speed, not one value.
// A playout that reaches the cut stops at the position before the roll and writes it out; the caller
// values it with its leaf evaluator (net.cu for nets) as rollout.rs does with owner_chances.
typedef unsigned char u8;
typedef signed char i8;
typedef unsigned int u32;

#define BASE_T (-1)
#define LAST_TRACK 50
#define HOME_FIRST 51
#define FINISHED 56
#define TRACK_LEN 52
#define MAXM 64
#define MAXCAP 12
#define MAX_TRAY 32
#define NF 19
#define PHASE_ROLL 0
#define PHASE_MOVE 1
#define PHASE_OVER 2
#define KIND_RELEASE 0
#define KIND_SINGLE 1
#define KIND_PAIR 2
// one position record (host and device agree on this layout, gpu_playout.rs)
#define REC 80

__device__ __constant__ int START_SQ[4] = {39, 0, 13, 26};

struct Player { u8 color, owner; i8 tok[4]; };
struct Board { int n; Player p[4]; u8 idx[4]; };
struct Move {
  u8 kind, color, ntok, tok0, tok1, roll, ncap, finishes;
  i8 from, to, steps;
  u8 caps[MAXCAP];  // (colour << 2) | token
};
struct MoveList { int n; Move m[MAXM]; };
struct G {
  Board b;
  int current;
  u8 phase, sixes, singles, nrank;
  int nrolls;
  u8 rolls[MAX_TRAY];
  u8 ranking[4];
  u32 turn_count;
};

// ---------------------------------------------------------------- rng.rs / dice.rs
__device__ __forceinline__ double rng_next(u32* a) {
  *a = *a + 0x6d2b79f5u;
  u32 x = *a;
  u32 t = (x ^ (x >> 15)) * (1u | x);
  t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
  return (double)(t ^ (t >> 14)) / 4294967296.0;
}

// dice.rs sample_face(&FAIR, rng)
__device__ __forceinline__ u8 sample_fair(u32* a) {
  double r = rng_next(a);
  const double w = 1.0 / 6.0;
  for (int i = 0; i < 5; i++) {
    r -= w;
    if (r < 0.0) return (u8)(i + 1);
  }
  return 6;
}

// ---------------------------------------------------------------- jsmath.rs exp
__device__ __forceinline__ unsigned int pw_hi(double x) { return (unsigned int)(__double_as_longlong(x) >> 32); }
__device__ __forceinline__ unsigned int pw_lo(double x) { return (unsigned int)(__double_as_longlong(x)); }
__device__ __forceinline__ double pw_words(unsigned int h, unsigned int l) {
  return __longlong_as_double((long long)(((unsigned long long)h << 32) | (unsigned long long)l));
}

__device__ double js_exp(double x) {
  const double one = 1.0;
  const double halfv[2] = {0.5, -0.5};
  const double o_threshold = 7.09782712893383973096e+02;
  const double u_threshold = -7.45133219101941108420e+02;
  const double ln2hi[2] = {6.93147180369123816490e-01, -6.93147180369123816490e-01};
  const double ln2lo[2] = {1.90821492927058770002e-10, -1.90821492927058770002e-10};
  const double invln2 = 1.44269504088896338700e+00;
  const double P1 = 1.66666666666666019037e-01;
  const double P2 = -2.77777777770155933842e-03;
  const double P3 = 6.61375632143793436117e-05;
  const double P4 = -1.65339022054652515390e-06;
  const double P5 = 4.13813679705723846039e-08;
  const double E = 2.718281828459045;
  const double huge = 1.0e+300;
  const double twom1000 = 9.33263618503218878990e-302;
  const double two1023 = 8.988465674311579539e307;
  double hi_ = 0.0, lo_ = 0.0;
  int k = 0;
  unsigned int hx = pw_hi(x);
  int xsb = (int)((hx >> 31) & 1);
  hx &= 0x7fffffffu;
  if (hx >= 0x40862E42u) {
    if (hx >= 0x7ff00000u) {
      if (((hx & 0xfffffu) | pw_lo(x)) != 0) return x + x;
      return xsb == 0 ? x : 0.0;
    }
    if (x > o_threshold) return huge * huge;
    if (x < u_threshold) return twom1000 * twom1000;
  }
  if (hx > 0x3FD62E42u) {
    if (hx < 0x3FF0A2B2u) {
      if (x == 1.0) return E;
      hi_ = x - ln2hi[xsb];
      lo_ = ln2lo[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = (int)(invln2 * x + halfv[xsb]);
      double t = (double)k;
      hi_ = x - t * ln2hi[0];
      lo_ = t * ln2lo[0];
    }
    x = hi_ - lo_;
  } else if (hx < 0x3E300000u) {
    if (huge + x > one) return one + x;
  } else {
    k = 0;
  }
  double t = x * x;
  double twopk = k >= -1021 ? pw_words((unsigned int)(0x3FF00000 + (k << 20)), 0) : pw_words((unsigned int)(0x3FF00000 + ((k + 1000) << 20)), 0);
  double c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k == 0) return one - ((x * c) / (c - 2.0) - x);
  double y = one - ((lo_ - (x * c) / (2.0 - c)) - hi_);
  if (k >= -1021) {
    if (k == 1024) return y * 2.0 * two1023;
    return y * twopk;
  }
  return y * twopk * twom1000;
}

__device__ __forceinline__ double js_max2(double a, double b) {
  if (isnan(a) || isnan(b)) return __longlong_as_double(0x7ff8000000000000LL);
  if (a > b) return a;
  if (b > a) return b;
  if (a == 0.0 && b == 0.0) return (!signbit(a) || !signbit(b)) ? 0.0 : -0.0;
  return a;
}

// ---------------------------------------------------------------- rules.rs
__device__ __forceinline__ bool is_safe(int sq) {
  return sq == 0 || sq == 8 || sq == 13 || sq == 21 || sq == 26 || sq == 34 || sq == 39 || sq == 47;
}

__device__ __forceinline__ int square_of(int color, int progress) {
  if (progress < 0 || progress > LAST_TRACK) return -1;
  return (START_SQ[color] + progress) % TRACK_LEN;
}

__device__ __forceinline__ const Player& of(const Board& b, int color) { return b.p[b.idx[color]]; }

__device__ __forceinline__ int count_at(const Board& b, int color, int sq) {
  if (b.idx[color] == 255) return 0;
  const Player& p = of(b, color);
  int c = 0;
  for (int i = 0; i < 4; i++) c += square_of(color, p.tok[i]) == sq;
  return c;
}

__device__ __forceinline__ bool is_done(const Player& p) {
  return p.tok[0] == FINISHED && p.tok[1] == FINISHED && p.tok[2] == FINISHED && p.tok[3] == FINISHED;
}

__device__ bool is_blocked_for(const Board& b, int sq, int mover, bool singles) {
  if (singles || is_safe(sq)) return false;
  int me = of(b, mover).owner;
  for (int k = 0; k < b.n; k++) {
    const Player& p = b.p[k];
    if (p.owner == me) continue;
    int c = 0;
    for (int i = 0; i < 4; i++) c += square_of(p.color, p.tok[i]) == sq;
    if (c >= 2) return true;
  }
  return false;
}

__device__ __forceinline__ bool is_locked(const Board& b, int color, int progress, bool singles) {
  if (singles) return false;
  int sq = square_of(color, progress);
  return sq >= 0 && !is_safe(sq) && count_at(b, color, sq) % 2 == 0;
}

__device__ bool walk(const Board& b, int color, int from, int steps, bool pair, bool singles, Move& mv) {
  if (from == BASE_T) return false;
  int to = from + steps;
  if (to > FINISHED) return false;
  if (!pair) {
    for (int p = from + 1; p < to; p++) {
      int sq = square_of(color, p);
      if (sq >= 0 && is_blocked_for(b, sq, color, singles)) return false;
    }
  }
  mv.to = (i8)to;
  mv.ncap = 0;
  int sq = square_of(color, to);
  if (sq >= 0 && !is_safe(sq)) {
    int me = of(b, color).owner;
    for (int k = 0; k < b.n; k++) {
      const Player& p = b.p[k];
      if (p.owner == me) continue;
      u8 here[4];
      int nh = 0;
      for (int i = 0; i < 4; i++)
        if (square_of(p.color, p.tok[i]) == sq) here[nh++] = (u8)i;
      if (singles) {
        for (int j = 0; j < nh; j++) mv.caps[mv.ncap++] = (u8)((p.color << 2) | here[j]);
      } else if (pair) {
        if (nh >= 2)
          for (int j = 0; j < 2; j++) mv.caps[mv.ncap++] = (u8)((p.color << 2) | here[j]);
      } else if (nh % 2 == 1) {
        mv.caps[mv.ncap++] = (u8)((p.color << 2) | here[nh - 1]);
      }
    }
  }
  return true;
}

__device__ __forceinline__ void push(MoveList& out, const Move& m, int* err) {
  if (out.n >= MAXM) { *err = 1; return; }
  out.m[out.n++] = m;
}

__device__ __forceinline__ Move empty_move(int kind, int color, int roll) {
  Move m;
  m.kind = (u8)kind; m.color = (u8)color; m.ntok = 1; m.tok0 = 0; m.tok1 = 0; m.roll = (u8)roll;
  m.ncap = 0; m.finishes = 0; m.from = 0; m.to = 0; m.steps = 0;
  return m;
}

__device__ void legal_moves(const Board& b, int color, int roll, bool singles, MoveList& out, int* err) {
  const Player me = of(b, color);
  int r = roll;
  if (roll == 6) {
    for (int i = 0; i < 4; i++) {
      if (me.tok[i] == BASE_T) {
        Move m = empty_move(KIND_RELEASE, color, roll);
        m.tok0 = (u8)i; m.from = BASE_T; m.to = 0; m.steps = 0;
        push(out, m, err);
      }
    }
  }
  unsigned long long seen = 0;
  for (int i = 0; i < 4; i++) {
    int t = me.tok[i];
    if (t == BASE_T || t == FINISHED || ((seen >> t) & 1ull)) continue;
    seen |= 1ull << t;
    if (is_locked(b, color, t, singles)) continue;
    Move mv = empty_move(KIND_SINGLE, color, roll);
    mv.tok0 = (u8)i; mv.from = (i8)t; mv.steps = (i8)r;
    if (walk(b, color, t, r, false, singles, mv)) {
      mv.finishes = mv.to == FINISHED ? 1 : 0;
      push(out, mv, err);
    }
  }
  if (roll % 2 == 0 && !singles) {
    int half = r / 2;
    int gt[4]; u8 gi[4][4]; int gn[4]; int ng = 0;
    for (int i = 0; i < 4; i++) {
      int t = me.tok[i];
      if (t < 0 || t > LAST_TRACK) continue;
      int k = -1;
      for (int q = 0; q < ng; q++) if (gt[q] == t) { k = q; break; }
      if (k >= 0) { gi[k][gn[k]++] = (u8)i; }
      else { gt[ng] = t; gi[ng][0] = (u8)i; gn[ng] = 1; ng++; }
    }
    for (int k = 0; k < ng; k++) {
      if (gn[k] < 2) continue;
      int t = gt[k];
      Move mv = empty_move(KIND_PAIR, color, roll);
      mv.ntok = 2; mv.tok0 = gi[k][0]; mv.tok1 = gi[k][1]; mv.from = (i8)t; mv.steps = (i8)half;
      if (walk(b, color, t, half, true, false, mv)) {
        mv.finishes = mv.to == FINISHED ? 2 : 0;
        push(out, mv, err);
      }
    }
  }
}

__device__ __forceinline__ void apply_move(Board& b, const Move& m) {
  Player& me = b.p[b.idx[m.color]];
  me.tok[m.tok0] = m.to;
  if (m.ntok == 2) me.tok[m.tok1] = m.to;
  for (int j = 0; j < m.ncap; j++) {
    int c = m.caps[j] >> 2, t = m.caps[j] & 3;
    b.p[b.idx[c]].tok[t] = BASE_T;
  }
}

// ---------------------------------------------------------------- game.rs
__device__ void tray_moves(const Board& b, int color, const u8* rolls, int nrolls, bool singles, MoveList& out, int* err) {
  out.n = 0;
  for (int d = 6; d >= 1; d--) {
    bool has = false;
    for (int i = 0; i < nrolls; i++) has |= rolls[i] == d;
    if (has) legal_moves(b, color, d, singles, out, err);
  }
}

__device__ __forceinline__ int next_player(const G& g) {
  int n = g.b.n;
  for (int k = 1; k <= n; k++) {
    int i = (g.current + k) % n;
    if (!is_done(g.b.p[i])) return i;
  }
  return g.current;
}

__device__ __forceinline__ void pass_turn(G& g, MoveList& ml) {
  g.current = next_player(g);
  g.nrolls = 0;
  g.sixes = 0;
  g.turn_count += 1;
  g.phase = PHASE_ROLL;
  ml.n = 0;
}

__device__ void roll(G& g, MoveList& ml, int dice, int* err) {
  int color = g.b.p[g.current].color;
  int sixes = dice == 6 ? g.sixes + 1 : 0;
  if (sixes == 3) {
    int kept = g.nrolls - 2;
    tray_moves(g.b, color, g.rolls, kept, g.singles, ml, err);
    if (ml.n != 0) {
      g.nrolls = kept;
      g.sixes = 0;
      g.phase = PHASE_MOVE;
    } else {
      pass_turn(g, ml);
    }
    return;
  }
  if (g.nrolls >= MAX_TRAY) { *err = 2; return; }
  g.rolls[g.nrolls++] = (u8)dice;
  if (dice == 6) {
    g.sixes = (u8)sixes;
    ml.n = 0;
    return;
  }
  tray_moves(g.b, color, g.rolls, g.nrolls, g.singles, ml, err);
  if (ml.n == 0) {
    pass_turn(g, ml);
    return;
  }
  g.sixes = (u8)sixes;
  g.phase = PHASE_MOVE;
}

__device__ void play(G& g, MoveList& ml, const Move m, int* err) {
  apply_move(g.b, m);
  int cur = g.current;
  bool me_done = is_done(g.b.p[cur]);
  if (me_done) g.ranking[g.nrank++] = g.b.p[cur].color;
  int owner_left = 255;
  bool many = false;
  for (int k = 0; k < g.b.n; k++) {
    const Player& p = g.b.p[k];
    if (is_done(p)) continue;
    if (owner_left == 255) owner_left = p.owner;
    else if (p.owner != owner_left) many = true;
  }
  if (!many) {
    for (int i = 0; i < g.b.n; i++)
      if (!is_done(g.b.p[i])) g.ranking[g.nrank++] = g.b.p[i].color;
    g.phase = PHASE_OVER;
    ml.n = 0;
    return;
  }
  for (int k = 0; k < g.nrolls; k++) {
    if (g.rolls[k] == m.roll) {
      for (int q = k; q + 1 < g.nrolls; q++) g.rolls[q] = g.rolls[q + 1];
      g.nrolls -= 1;
      break;
    }
  }
  bool extra = !me_done && (m.ncap > 0 || m.finishes > 0);
  if (extra) {
    g.phase = PHASE_ROLL;
    g.sixes = 0;
    ml.n = 0;
    return;
  }
  if (me_done) {
    ml.n = 0;
  } else {
    tray_moves(g.b, g.b.p[cur].color, g.rolls, g.nrolls, g.singles, ml, err);
  }
  if (ml.n != 0) return;
  pass_turn(g, ml);
}

// owner_ranking()[0]: done people by their last colour's place, then the rest by total progress (stable)
__device__ int winner(const G& g) {
  int owners[4], no = 0;
  for (int k = 0; k < g.b.n; k++) {
    int o = g.b.p[k].owner;
    bool has = false;
    for (int q = 0; q < no; q++) has |= owners[q] == o;
    if (!has) owners[no++] = o;
  }
  int done[4], place[4], prog[4];
  for (int q = 0; q < no; q++) {
    int o = owners[q];
    bool d = true;
    int pl = -2147483647 - 1, pr = 0;
    for (int k = 0; k < g.b.n; k++) {
      const Player& p = g.b.p[k];
      if (p.owner != o) continue;
      d = d && is_done(p);
      int pos = -1;
      for (int r = 0; r < g.nrank; r++) if (g.ranking[r] == p.color) { pos = r; break; }
      if (pos > pl) pl = pos;
      for (int i = 0; i < 4; i++) pr += p.tok[i] > 0 ? p.tok[i] : 0;
    }
    done[q] = d; place[q] = pl; prog[q] = pr;
  }
  // stable insertion sort with owner_ranking's comparator
  int ord[4];
  for (int q = 0; q < no; q++) ord[q] = q;
  for (int i = 1; i < no; i++) {
    int x = ord[i];
    int j = i - 1;
    while (j >= 0) {
      int a = ord[j], b2 = x;
      int d = done[b2] - done[a];
      int k = d != 0 ? d : (done[a] ? place[a] - place[b2] : prog[b2] - prog[a]);
      if (k > 0) { ord[j + 1] = ord[j]; j--; } else break;
    }
    ord[j + 1] = x;
  }
  return owners[ord[0]];
}

// ---------------------------------------------------------------- encode.rs features + eval.rs Linear
__device__ __forceinline__ double reach(int gap) {
  if (gap >= 1 && gap <= 6) return 1.0 / 6.0;
  if (gap >= 7 && gap <= 12) return 1.0 / 36.0;
  return 0.0;
}

// features() for one player index i into f[NF]; `at` is the per-square count table.
__device__ void features_one(const Board& b, int current, bool singles, const u8 (*at)[4], int i, double* f) {
  int n = b.n;
  const Player& p = b.p[i];
  for (int k = 0; k < NF; k++) f[k] = 0.0;
  const double fin = (double)FINISHED;
  int pips = 0, max_p = 0, min_p = FINISHED, live = 0;
  for (int q = 0; q < 4; q++) {
    int t = p.tok[q];
    pips += FINISHED - (t > BASE_T ? t : BASE_T);
    if (t == BASE_T) f[1] += 0.25;
    else if (t == FINISHED) f[2] += 0.25;
    else if (t >= HOME_FIRST) f[3] += 0.25;
    if (t != FINISHED) {
      live += 1;
      max_p = max_p > t + 1 ? max_p : t + 1;
      min_p = min_p < t + 1 ? min_p : t + 1;
    }
  }
  f[0] = (double)pips / (double)(4 * (FINISHED + 1));
  f[12] = (double)max_p / fin;
  f[13] = live != 0 ? (double)min_p / fin : 1.0;
  unsigned long long seen = 0;
  for (int q = 0; q < 4; q++) {
    int t = p.tok[q];
    int sq = square_of(p.color, t);
    if (sq < 0 || ((seen >> sq) & 1ull)) continue;
    seen |= 1ull << sq;
    double mine = (double)at[sq][i];
    if (is_safe(sq)) {
      f[8] += mine / 4.0;
      bool behind = false;
      int j = 0;
      while (j < n && !behind) {
        if (j != i && b.p[j].owner != p.owner) {
          for (int r = 0; r < 4; r++) {
            int e = b.p[j].tok[r];
            int es = square_of(b.p[j].color, e);
            if (es < 0) continue;
            int gap = (sq - es + TRACK_LEN) % TRACK_LEN;
            if (gap >= 1 && gap <= 12 && e + gap <= LAST_TRACK) behind = true;
          }
        }
        j += 1;
      }
      if (behind) f[11] += mine / 4.0;
      continue;
    }
    int c0 = at[sq][i];
    bool dbl = !singles && !is_safe(sq) && c0 >= 2 && c0 % 2 == 0;
    if (dbl) f[9] += mine / 4.0;
    double safe_p = 1.0;
    for (int j = 0; j < n; j++) {
      if (j == i || b.p[j].owner == p.owner) continue;
      const Player& qp = b.p[j];
      unsigned long long counted = 0;
      for (int r = 0; r < 4; r++) {
        int e = qp.tok[r];
        int es = square_of(qp.color, e);
        if (es < 0 || ((counted >> es) & 1ull)) continue;
        counted |= 1ull << es;
        int gap = (sq - es + TRACK_LEN) % TRACK_LEN;
        if (e + gap > LAST_TRACK) continue;
        if (dbl) {
          int ce = at[es][j];
          bool edbl = !singles && !is_safe(es) && ce >= 2 && ce % 2 == 0;
          if (edbl && gap >= 1 && gap <= 3) safe_p *= 5.0 / 6.0;
        } else {
          safe_p *= 1.0 - reach(gap);
        }
        if (dbl && gap >= 1 && gap <= 6) f[10] += (double)at[es][j] / 4.0;
      }
    }
    double hit = 1.0 - safe_p;
    f[4] += hit * (mine / 4.0);
    f[5] += hit * (mine / 4.0) * ((double)(t + 1) / fin);
    for (int j = 0; j < n; j++) {
      if (j == i || b.p[j].owner == p.owner) continue;
      const Player& qp = b.p[j];
      for (int r = 0; r < 4; r++) {
        int e = qp.tok[r];
        int es = square_of(qp.color, e);
        if (es < 0 || is_safe(es)) continue;
        int ce = at[es][j];
        bool edbl = !singles && ce >= 2 && ce % 2 == 0;  // is_safe(es) is false here
        if (edbl) continue;
        int gap = (es - sq + TRACK_LEN) % TRACK_LEN;
        if (t + gap > LAST_TRACK) continue;
        double rr = reach(gap);
        f[6] += rr;
        f[7] += rr * ((double)(e + 1) / fin);
      }
    }
  }
  f[14 + (i + n - current) % n] = 1.0;
  f[18] = singles ? 1.0 : 0.0;
}

// Evaluator::Linear owner_chances: w[0..19] hand rules, w[19..26] turn rules (tray1..6, sixes).
__device__ void linear_chances(const G& g, const double* w, int people, double* out) {
  u8 at[52][4];
  for (int s = 0; s < 52; s++) { at[s][0] = 0; at[s][1] = 0; at[s][2] = 0; at[s][3] = 0; }
  for (int i = 0; i < g.b.n; i++)
    for (int q = 0; q < 4; q++) {
      int sq = square_of(g.b.p[i].color, g.b.p[i].tok[q]);
      if (sq >= 0) at[sq][i] += 1;
    }
  double s[4] = {0.0, 0.0, 0.0, 0.0};
  double f[NF];
  for (int i = 0; i < g.b.n; i++) {
    features_one(g.b, g.current, g.singles, at, i, f);
    int o = g.b.p[i].owner;
    for (int k = 0; k < NF; k++) s[o] += w[k] * f[k];
  }
  int me = g.b.p[g.current].owner;
  for (int r = 0; r < g.nrolls; r++) s[me] += w[NF + g.rolls[r] - 1] / 3.0;
  s[me] += (w[NF + 6] * (double)g.sixes) / 2.0;
  // chances_from_scores
  bool live[4] = {false, false, false, false};
  for (int k = 0; k < g.b.n; k++)
    if (!is_done(g.b.p[k])) live[g.b.p[k].owner] = true;
  double top = -1.0 / 0.0;
  for (int o = 0; o < people; o++)
    if (live[o]) top = js_max2(top, s[o]);
  double sum = 0.0;
  for (int o = 0; o < people; o++) {
    s[o] = live[o] ? js_exp(s[o] - top) : 0.0;
    sum += s[o];
  }
  for (int o = 0; o < people; o++) out[o] = s[o] / sum;
}

// ---------------------------------------------------------------- search.rs at depth 1
struct Ctx {
  const double* w;
  int chance_max;
  int people;  // owners
  int err;
};

__device__ void owner_values(const G& s, Ctx& cx, double* v) {
  for (int o = 0; o < 4; o++) v[o] = 0.0;
  if (s.phase == PHASE_OVER) {
    v[winner(s)] = 1.0;
    return;
  }
  linear_chances(s, cx.w, cx.people, v);
}

// search.rs node() with turns_left = 1 (depth 1): the mover plans the rest of the turn.
__device__ void node(const G& s, const MoveList& ml, int who, int chance, Ctx& cx, double* v) {
  if (s.phase == PHASE_OVER || s.current != who) {
    owner_values(s, cx, v);
    return;
  }
  if (s.phase == PHASE_MOVE) {
    int me = s.b.p[who].owner;
    double best[4] = {-1.0, -1.0, -1.0, -1.0};
    for (int i = 0; i < ml.n; i++) {
      G t = s;
      MoveList tm;
      tm.n = 0;
      play(t, tm, ml.m[i], &cx.err);
      double c[4];
      node(t, tm, who, chance, cx, c);
      if (c[me] > best[me]) { best[0] = c[0]; best[1] = c[1]; best[2] = c[2]; best[3] = c[3]; }
    }
    for (int o = 0; o < 4; o++) v[o] = best[o];
    return;
  }
  if (chance >= cx.chance_max) {
    owner_values(s, cx, v);
    return;
  }
  double acc[4] = {0.0, 0.0, 0.0, 0.0};
  for (int f = 1; f <= 6; f++) {
    G t = s;
    MoveList tm;
    tm.n = 0;
    roll(t, tm, f, &cx.err);
    double c[4];
    node(t, tm, who, chance + 1, cx, c);
    for (int o = 0; o < cx.people; o++) acc[o] += c[o] / 6.0;
  }
  for (int o = 0; o < 4; o++) v[o] = acc[o];
}

// choose_extreme at temperature 0: one rng draw per move when there are several.
__device__ int choose(const G& g, const MoveList& ml, u32* rng, Ctx& cx) {
  if (ml.n == 1) return 0;
  int me = g.b.p[g.current].owner;
  double vals[MAXM];
  for (int i = 0; i < ml.n; i++) {
    G t = g;
    MoveList tm;
    tm.n = 0;
    play(t, tm, ml.m[i], &cx.err);
    double c[4];
    node(t, tm, g.current, 0, cx, c);
    vals[i] = c[me];
  }
  int best = 0;
  for (int i = 0; i < ml.n; i++)
    if (vals[i] + rng_next(rng) * 1e-9 > vals[best]) best = i;
  return best;
}

// ---------------------------------------------------------------- records
__device__ void load(const u8* r, G& g) {
  g.b.n = r[0];
  g.current = r[1];
  g.phase = r[2];
  g.sixes = r[3];
  g.nrolls = r[4];
  g.singles = r[5];
  g.nrank = r[6];
  for (int i = 0; i < 4; i++) {
    g.b.p[i].color = r[8 + i];
    g.b.p[i].owner = r[12 + i];
    for (int q = 0; q < 4; q++) g.b.p[i].tok[q] = (i8)r[16 + 4 * i + q];
    g.b.idx[i] = r[72 + i];
    g.ranking[i] = r[64 + i];
  }
  for (int k = 0; k < MAX_TRAY; k++) g.rolls[k] = r[32 + k];
  g.turn_count = (u32)r[68] | ((u32)r[69] << 8) | ((u32)r[70] << 16) | ((u32)r[71] << 24);
}

__device__ void store(const G& g, u8* r) {
  for (int k = 0; k < REC; k++) r[k] = 0;
  r[0] = (u8)g.b.n; r[1] = (u8)g.current; r[2] = g.phase; r[3] = g.sixes; r[4] = (u8)g.nrolls; r[5] = g.singles; r[6] = g.nrank;
  for (int i = 0; i < 4; i++) {
    r[8 + i] = g.b.p[i].color;
    r[12 + i] = g.b.p[i].owner;
    for (int q = 0; q < 4; q++) r[16 + 4 * i + q] = (u8)g.b.p[i].tok[q];
    r[72 + i] = g.b.idx[i];
    r[64 + i] = g.ranking[i];
  }
  for (int k = 0; k < MAX_TRAY; k++) r[32 + k] = g.rolls[k];
  r[68] = (u8)(g.turn_count & 255); r[69] = (u8)((g.turn_count >> 8) & 255);
  r[70] = (u8)((g.turn_count >> 16) & 255); r[71] = (u8)((g.turn_count >> 24) & 255);
}

// One thread per playout. streams[5 * i ..]: dice per seat (4) then the policy rng; updated in place.
// status: 0 finished (result = 1 if the mover's person won, else 0), 1 stopped at the cut (the position
// is in leaves), negative = an internal limit was hit (never on legal play; the caller checks).
extern "C" __global__ void playouts(const u8* starts, const u8* mes, u32* streams, int n, int cut, int has_eval,
                                    const double* w, int chance_max, int people, double* result, u8* leaves, int* status) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  G g;
  load(starts + (size_t)i * REC, g);
  MoveList ml;
  ml.n = 0;
  Ctx cx;
  cx.w = w; cx.chance_max = chance_max; cx.people = people; cx.err = 0;
  if (g.phase == PHASE_MOVE) tray_moves(g.b, g.b.p[g.current].color, g.rolls, g.nrolls, g.singles, ml, &cx.err);
  u32 dice[4] = {streams[5 * i], streams[5 * i + 1], streams[5 * i + 2], streams[5 * i + 3]};
  u32 rng = streams[5 * i + 4];
  int me = mes[i];
  u32 turns = 0;
  int cur = g.current;
  int steps = 0;
  int st = 0;
  double res = 0.0;
  bool stopped = false;
  while (g.phase != PHASE_OVER && steps < 50000) {
    if (g.phase == PHASE_ROLL) {
      if (cut > 0 && turns >= (u32)cut && has_eval) {
        store(g, leaves + (size_t)i * REC);
        st = 1;
        stopped = true;
        break;
      }
      int f = sample_fair(&dice[g.current]);
      roll(g, ml, f, &cx.err);
    } else {
      int k = choose(g, ml, &rng, cx);
      Move m = ml.m[k];
      play(g, ml, m, &cx.err);
    }
    if (g.current != cur) {
      cur = g.current;
      turns += 1;
    }
    steps += 1;
    if (cx.err) break;
  }
  if (!stopped) res = (g.phase == PHASE_OVER && winner(g) == me) ? 1.0 : 0.0;
  if (cx.err) st = -cx.err;
  result[i] = res;
  status[i] = st;
  streams[5 * i] = dice[0]; streams[5 * i + 1] = dice[1]; streams[5 * i + 2] = dice[2]; streams[5 * i + 3] = dice[3];
  streams[5 * i + 4] = rng;
}
