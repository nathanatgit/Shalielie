import { discoverHeic, extractItemData, auxUriForItem } from "./heif.js?v=0.6.0-web";
import { bytesEqual } from "./box.js?v=0.6.0-web";
import { parseBplist } from "./bplist.js?v=0.6.0-web";

export function equalValues(a, b) {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array)
    return a instanceof Uint8Array && b instanceof Uint8Array && bytesEqual(a, b);
  if (a instanceof Map || b instanceof Map)
    return a instanceof Map && b instanceof Map && a.size === b.size &&
      [...a].every(([key, value]) => b.has(key) && equalValues(value, b.get(key)));
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equalValues(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equalValues(a[k], b[k]));
  }
  return false;
}

/** Exact encoded data/settings comparison, independent of item IDs, file offsets,
 * preview decoding and property indices. Does not claim decoded pixels match. */
export function inspectionComparator(beforeBytes, afterBytes) {
  const before = beforeBytes ? discoverHeic(beforeBytes) : null;
  const after = afterBytes ? discoverHeic(afterBytes) : null;
  const cache = new Map(), active = new Set();
  const properties = (bytes, d, id) => (d.props.associations.get(id) || []).map(a => {
    const p = d.props.properties[a.index - 1];
    if (!p?.box) throw new Error("Missing item property");
    return { type: p.type, essential: a.essential, bytes: bytes.subarray(p.box.off, p.box.off + p.box.size) };
  });
  const role = (d, id) => {
    if (!d.infos.has(id)) throw new Error("Dangling item reference");
    for (const key of ["primary", "hdrGrid", "linearThumb", "deltaGrid", "thumbnail", "stylesItem"])
      if (d[key] === id) return key;
    const info = d.infos.get(id);
    return [info.type, info.uri, info.contentType, auxUriForItem(d.props, id), info.name];
  };
  const itemDiff = (a, b) => {
    const key = `${a}/${b}`;
    if (cache.has(key)) return cache.get(key);
    if (active.has(key)) throw new Error("Cyclic image graph");
    active.add(key);
    try {
      const ai = before.infos.get(a), bi = after.infos.get(b);
      if (!ai || !bi) throw new Error("Missing image item");
      const differences = [], orderChanges = [];
      const add = (path, kind, left, right) => differences.push({path,kind,before:left,after:right});
      if (!equalValues([ai.type, ai.uri, ai.contentType], [bi.type, bi.uri, bi.contentType]))
        add('item', 'type', [ai.type, ai.uri, ai.contentType], [bi.type, bi.uri, bi.contentType]);
      const ap = extractItemData(beforeBytes,before,a), bp = extractItemData(afterBytes,after,b);
      if (!bytesEqual(ap,bp)) {
        const payloadDiff = valueDifferences(ap,bp,'payload');
        if (['uri ','mime'].includes(ai.type)) {
          try {
            const fields = valueDifferences(parseBplist(ap),parseBplist(bp),'fields');
            differences.push(...(fields.length ? fields : payloadDiff.map(d=>({...d,kind:'serialization'}))));
          } catch { differences.push(...payloadDiff); }
        } else differences.push(...payloadDiff);
      }
      const aps = properties(beforeBytes,before,a), bps = properties(afterBytes,after,b);
      // Descriptive properties can move around other property types without
      // changing their values. Keep relative ordering of transformations and
      // unknown properties, and compare repeated properties in their own order.
      const descriptive = new Set(['colr','ispe','pixi','auxC','hvcC','clli','mdcv','pasp']);
      const ordered = ps => ps.filter(p=>!descriptive.has(p.type)).map(p=>p.type);
      if (!equalValues(ordered(aps),ordered(bps)))
        add('properties','propertyOrder',ordered(aps),ordered(bps));
      else if(!equalValues(aps.map(p=>p.type),bps.map(p=>p.type)) &&
        equalValues(aps.map(p=>p.type).sort(),bps.map(p=>p.type).sort()))
        orderChanges.push({path:'properties',kind:'propertyOrder',before:aps.map(p=>p.type),after:bps.map(p=>p.type)});
      for (const type of new Set([...aps,...bps].map(p=>p.type))) {
        const left = aps.filter(p=>p.type===type), right = bps.filter(p=>p.type===type);
        for(let i=0;i<Math.max(left.length,right.length);i++) {
          const x=left[i], y=right[i], path=`${type}${Math.max(left.length,right.length)>1?`[${i+1}]`:''}`;
          if(!x || !y) add(path,'property',x?propertySummary(x):null,y?propertySummary(y):null);
          else {
            if(x.essential!==y.essential) add(`${path}.essential`,'property',x.essential,y.essential);
            if(!bytesEqual(x.bytes,y.bytes)) add(path,'property',{...propertySummary(x),...binarySummary(x.bytes,y.bytes)},{...propertySummary(y),...binarySummary(y.bytes,x.bytes)});
          }
        }
      }
      const ownDataSame = differences.length===0 && orderChanges.length===0;
      const ar = before.refs.filter(r => r.from === a), br = after.refs.filter(r => r.from === b);
      if(!equalValues(ar.map(r=>[r.type,r.to.length]),br.map(r=>[r.type,r.to.length])))
        add('references','reference',ar.map(r=>[r.type,r.to.length]),br.map(r=>[r.type,r.to.length]));
      for(let i=0;i<Math.min(ar.length,br.length);i++) {
        const x=ar[i],y=br[i]; if(x.type!==y.type) continue;
        for(let j=0;j<Math.min(x.to.length,y.to.length);j++) {
          const leftRole=role(before,x.to[j]),rightRole=role(after,y.to[j]);
          if(x.type==='dimg') {
            if(typeof leftRole==='string' && typeof rightRole==='string' && leftRole!==rightRole)
              add(`dimg[${j+1}]`,'reference',leftRole,rightRole);
            const label = typeof leftRole==='string' ? ({primary:'primary',hdrGrid:'HDR gain map',deltaGrid:'style delta map'}[leftRole] || leftRole) : `tile ${j+1}`;
            const child=itemDiff(x.to[j],y.to[j]);
            differences.push(...child.differences.map(d=>({...d,path:`${label} → ${d.path}`})));
            orderChanges.push(...child.orderChanges.map(d=>({...d,path:`${label} → ${d.path}`})));
          } else if(!equalValues(leftRole,rightRole)) add(`${x.type}[${j+1}]`,'reference',leftRole,rightRole);
        }
      }
      const result={differences,orderChanges,ownDataSame}; cache.set(key,result); return result;
    } finally { active.delete(key); }
  };
  let beforeStyles, afterStyles;
  const field = (bytes, d, entry, side) => {
    if (entry.name === "TextureStylePostProcessedPeopleData") {
      const metadata = parseBplist(extractItemData(bytes, d, entry.itemIds[0]));
      if (!(metadata instanceof Map) || !metadata.has(entry.name)) throw new Error("Missing people field");
      return metadata.get(entry.name);
    }
    if (["statistics", "value"].includes(entry.kind)) {
      const styles = side === "before" ? (beforeStyles ??= parseBplist(extractItemData(bytes,d,d.stylesItem)))
        : (afterStyles ??= parseBplist(extractItemData(bytes,d,d.stylesItem)));
      const group = styles.get(entry.kind === "statistics" ? "6" : "7");
      if (!(group instanceof Map) || !group.has(entry.name)) throw new Error("Missing style field");
      return group.get(entry.name);
    }
    throw new Error("No exact data for this row");
  };
  const explain = (a, b) => {
    if (!a?.present && !b?.present) return {status:"missing",differences:[]};
    if (!a?.present) return {status:"added",differences:[]};
    if (!b?.present) return {status:"removed",differences:[]};
    try {
      if (!before || !after) return {status:"unknown",differences:[]};
      const useField = ["statistics", "value"].includes(a.kind) || a.name === "TextureStylePostProcessedPeopleData";
      let differences=[],orderChanges=[],ownDataSame=null;
      if(useField) differences=valueDifferences(field(beforeBytes,before,a,"before"),field(afterBytes,after,b,"after"),a.name);
      else {
        if(!a.itemIds?.length || !b.itemIds?.length) throw new Error('No item IDs for comparison');
        if(a.itemIds.length!==b.itemIds.length) differences.push({path:a.name,kind:'itemCount',before:a.itemIds.length,after:b.itemIds.length});
        ownDataSame=a.itemIds.length===b.itemIds.length;
        for(let i=0;i<Math.min(a.itemIds.length,b.itemIds.length);i++) {
          const item=itemDiff(a.itemIds[i],b.itemIds[i]); ownDataSame &&= item.ownDataSame;
          differences.push(...item.differences.map(d=>({...d,path:`${a.name}${a.itemIds.length>1?`[${i+1}]`:''} → ${d.path}`})));
          orderChanges.push(...item.orderChanges.map(d=>({...d,path:`${a.name}${a.itemIds.length>1?`[${i+1}]`:''} → ${d.path}`})));
        }
      }
      return {status:differences.length?'different':orderChanges.length?'orderOnly':'same',differences,orderChanges,ownDataSame};
    } catch(error) { return {status:'unknown',differences:[],error:error.message}; }
  };
  const compare = (a,b) => explain(a,b).status;
  compare.explain=explain; return compare;
}

function binarySummary(bytes, other) {
  let changed=0,firstOffset=null;
  for(let i=0;i<Math.max(bytes.length,other.length);i++) if(bytes[i]!==other[i]) {changed++;firstOffset??=i;}
  return {bytes:bytes.length,changedBytes:changed,firstOffset};
}
export function valueDifferences(a,b,path='') {
  if(equalValues(a,b)) return [];
  const summary = v => v instanceof Uint8Array ? {bytes:v.length} : v instanceof Map ? {keys:[...v.keys()]} : Array.isArray(v) ? {length:v.length} : v??null;
  if(a instanceof Uint8Array && b instanceof Uint8Array)
    return [{path,kind:'payload',before:binarySummary(a,b),after:binarySummary(b,a)}];
  if(a instanceof Map && b instanceof Map) return [...new Set([...a.keys(),...b.keys()])].flatMap(key=>
    !a.has(key) || !b.has(key) ? [{path:`${path}.${key}`,kind:'field',before:a.has(key)?summary(a.get(key)):{missing:true},after:b.has(key)?summary(b.get(key)):{missing:true}}]
      : valueDifferences(a.get(key),b.get(key),`${path}.${key}`));
  if(Array.isArray(a) && Array.isArray(b)) return Array.from({length:Math.max(a.length,b.length)},(_,i)=>valueDifferences(a[i],b[i],`${path}[${i}]`)).flat();
  return [{path,kind:'field',before:summary(a),after:summary(b)}];
}
function propertySummary(p) {
  const b=p.bytes, read=(offset,size)=>b.slice(offset,offset+size).reduce((n,v)=>n*256+v,0);
  if(p.type==='ispe') return {width:read(12,4),height:read(16,4)};
  if(p.type==='irot') return {degrees:(b[8]&3)*90};
  if(p.type==='imir') return {axis:b[8]&1};
  if(p.type==='pixi') return {bits:[...b.slice(13)]};
  if(p.type==='colr' && String.fromCharCode(...b.slice(8,12))==='nclx')
    return {type:'nclx',primaries:read(12,2),transfer:read(14,2),matrix:read(16,2),fullRange:Boolean(b[18]&128)};
  if(p.type==='colr') return {type:String.fromCharCode(...b.slice(8,12)),bytes:b.length,hex:[...b].map(v=>v.toString(16).padStart(2,'0')).join('')};
  if(p.type==='hvcC') return {bytes:b.length,profile:b[9]&31,lumaBits:8+(b[25]&7),chromaBits:8+(b[26]&7),hex:[...b].map(v=>v.toString(16).padStart(2,'0')).join('')};
  return {bytes:b.length,hex:[...b].map(v=>v.toString(16).padStart(2,'0')).join('')};
}
