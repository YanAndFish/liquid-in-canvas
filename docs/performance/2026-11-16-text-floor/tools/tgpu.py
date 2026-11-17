import json, sys, collections
ev = json.load(open(sys.argv[1]))
depth = int(sys.argv[2]) if len(sys.argv) > 2 else 2
names = {}
for e in ev:
    if e.get('ph') == 'M' and e.get('name') == 'thread_name':
        names[(e['pid'], e['tid'])] = e['args']['name']
key = next(k for k, v in names.items() if v == 'CrGpuMain')
es = sorted([e for e in ev if (e.get('pid'), e.get('tid')) == key and e.get('ph') == 'X' and 'dur' in e], key=lambda e: (e['ts'], -e['dur']))
stack = []; self_t = collections.Counter(); incl = collections.Counter(); cnt = collections.Counter()
for e in es:
    while stack and stack[-1]['ts'] + stack[-1]['dur'] <= e['ts']:
        stack.pop()
    d = len(stack)
    path = e['name']
    if stack: stack[-1]['_child'] = stack[-1].get('_child', 0) + e['dur']
    e['_d'] = d
    stack.append(e)
for e in es:
    self_t[e['name']] += e['dur'] - e.get('_child', 0); incl[e['name']] += e['dur']; cnt[e['name']] += 1
print('按自身时间')
for n, d in self_t.most_common(18): print(f'{d/1e3:8.1f} ms self {incl[n]/1e3:8.1f} incl x{cnt[n]:<5} {n}')
