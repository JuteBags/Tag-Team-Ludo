"""AlphaLudo V17 as shipped on alphaludo.in (#148): answers tools/ai/h2h's requests on stdio.

    python v17.py model_v17.onnx          (h2h starts it; --probe prints the model's inputs and outputs and exits)

A request is one line: the V17 frame (ludo_core encode_unified_into, 1125 int8 values, space-separated), '|', then
the legal mask (225 characters, 0 or 1). The answer is one line: the chosen source cell, the argmax of the policy
over the legal cells (one forward pass, no search). The model file is fetched at run time and never kept.
"""
import sys

import numpy as np
import onnxruntime as ort

TYPES = {'tensor(int8)': np.int8, 'tensor(uint8)': np.uint8, 'tensor(float)': np.float32, 'tensor(int32)': np.int32, 'tensor(int64)': np.int64}

so = ort.SessionOptions()
so.intra_op_num_threads = 1
so.inter_op_num_threads = 1
sess = ort.InferenceSession(sys.argv[1], so, providers=['CPUExecutionProvider'])
ins, outs = sess.get_inputs(), sess.get_outputs()
print('V17 inputs', [(i.name, i.shape, i.type) for i in ins], 'outputs', [(o.name, o.shape, o.type) for o in outs], file=sys.stderr, flush=True)


def dims(shape):
    return [s if isinstance(s, int) else 1 for s in shape]


def size(shape):
    return int(np.prod(dims(shape)[1:])) if len(shape) > 1 else 1


def feed(x, m):
    d = {}
    for i in ins:
        n = size(i.shape)
        src = x if n == 1125 else m if n == 225 else None
        if src is None:
            raise SystemExit(f'V17: unexpected input {i.name} {i.shape}')
        d[i.name] = src.astype(TYPES[i.type]).reshape([1] + dims(i.shape)[1:])
    return d


policy = next((k for k, o in enumerate(outs) if o.shape and size(o.shape) == 225), None)
if policy is None:
    raise SystemExit('V17: no 225-cell policy output')
if '--probe' in sys.argv:
    x = np.zeros(1125, np.int8)
    m = np.zeros(225, np.float32)
    m[0] = 1
    out = sess.run(None, feed(x, m))
    print('V17 probe ok:', [np.asarray(o).shape for o in out], file=sys.stderr, flush=True)
    sys.exit(0)

for line in sys.stdin:
    a, b = line.rstrip('\n').split('|')
    x = np.array(a.split(), dtype=np.int8)
    m = (np.frombuffer(b.encode(), dtype=np.uint8) - 48).astype(np.float32)
    p = np.asarray(sess.run(None, feed(x, m))[policy], dtype=np.float64).reshape(-1)
    print(int(np.argmax(np.where(m > 0, p, -np.inf))), flush=True)
