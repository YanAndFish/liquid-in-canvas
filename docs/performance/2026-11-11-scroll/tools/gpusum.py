import json,sys,statistics as st
from collections import defaultdict
for path in sys.argv[1:]:
  for r in json.load(open(path)):
    agg=defaultdict(float); n=len(r['gpuPassTimes'])
    for times,infos in zip(r['gpuPassTimes'],r['gpuPassInfo']):
      for t,i in zip(times,infos):
        tgt='canvas' if not i or not i['target'] else ('full' if i['target'][0]>=3000 else ('half' if i['target'][0]>=1500 else 'blur'))
        agg[tgt]+=t
    print(path.split('/')[-1], 'gpu mean %.2f p50 %.2f'%(r['gpu']['mean'],r['gpu']['p50']), ' '.join('%s=%.2f'%(k,v/n) for k,v in sorted(agg.items())), 'anim %.1f'%r['animationInterval']['mean'])
