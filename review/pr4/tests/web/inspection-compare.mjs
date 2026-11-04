import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectionComparator, equalValues} from '../../web/src/inspection-compare.js';
import {discoverHeic, propertyBoxBytes, setItemPropertyAssociations} from '../../web/src/heif.js';
import {u} from '../../web/src/box.js';
import {extractItemData} from '../../web/src/heif.js';
const bytes = new Uint8Array(readFileSync('tests/private-fixtures/processed-style.heic'));
const d = discoverHeic(bytes);
const row = (name, itemIds, kind='metadata') => ({name,present:true,itemIds,kind});
const hdr = row('HDR gain map',[d.hdrGrid],'image');
const styles = row('styles',[d.stylesItem]);
const same = inspectionComparator(bytes,bytes.slice());
assert.equal(same(hdr,hdr),'same'); assert.equal(same(styles,styles),'same');
assert.equal(same(null,null),'missing'); assert.equal(same(null,hdr),'added'); assert.equal(same(hdr,null),'removed');
const copy = bytes.slice(), tile = d.iloc.items.get(d.hdrTiles[0]), extent = tile.extents[0];
copy[tile.baseOffset + extent.offset + extent.length - 1] ^= 1;
const changed = inspectionComparator(bytes,copy);
assert.equal(changed(hdr,hdr),'different'); assert.equal(changed(styles,styles),'same');
const detail=changed.explain(hdr,hdr);
assert.equal(detail.ownDataSame,true);
assert.equal(detail.differences.length,1);
assert.equal(detail.differences[0].path,'HDR gain map → tile 1 → payload');
assert.equal(detail.differences[0].before.changedBytes,1);
assert.equal(detail.differences[0].before.firstOffset,extent.length-1);
const tmapId=[...d.infos].find(([,i])=>i.type==='tmap')[0], tmap=row('tmap',[tmapId]);
const tmapDetail=changed.explain(tmap,tmap);
assert.equal(tmapDetail.status,'different'); assert.equal(tmapDetail.ownDataSame,true);
assert.equal(tmapDetail.differences[0].path,'tmap → HDR gain map → tile 1 → payload');
// Moving auxC across descriptive properties changes ipma order only.
const associations=d.props.associations.get(d.hdrGrid);
const isAux = a => d.props.properties[a.index-1].type==='auxC';
assert.ok(associations.some(isAux));
const otherAssociations=associations.filter(a=>!isAux(a));
const reordered=[...otherAssociations.slice(0,3),...associations.filter(isAux),...otherAssociations.slice(3)];
assert.notDeepEqual(reordered,associations);
const meta=bytes.slice(d.meta.off,d.meta.off+d.meta.size);
const movedMeta=setItemPropertyAssociations(meta,d.hdrGrid,reordered.map(a=>[a.index,a.essential]));
assert.equal(movedMeta.length,meta.length);
const moved=bytes.slice();moved.set(movedMeta,d.meta.off);
assert.equal(inspectionComparator(bytes,moved)(hdr,hdr),'orderOnly');
assert.equal(inspectionComparator(bytes,moved)(tmap,tmap),'orderOnly');
const movedDetail=inspectionComparator(bytes,moved).explain(hdr,hdr);
assert.equal(movedDetail.differences.length,0); assert.equal(movedDetail.orderChanges.length,1);
assert.equal(movedDetail.orderChanges[0].path,'HDR gain map → properties');
// Flags still matter after an otherwise harmless reordering.
const flaggedMeta=setItemPropertyAssociations(meta,d.hdrGrid,reordered.map(a=>[a.index,isAux(a)?!a.essential:a.essential]));
const flagged=bytes.slice();flagged.set(flaggedMeta,d.meta.off);
const flagDetail=inspectionComparator(bytes,flagged).explain(hdr,hdr);
assert.equal(flagDetail.status,'different');
assert.ok(flagDetail.differences.some(x=>x.path==='HDR gain map → auxC.essential'));
// Orientation/property edits count as differences even when all compressed bytes match.
const changedColor = bytes.slice(), color = propertyBoxBytes(bytes,d.props,d.hdrGrid,'colr');
if(color) {
  const index = Buffer.from(bytes).indexOf(Buffer.from(color)); changedColor[index+color.length-1] ^= 1;
  assert.equal(inspectionComparator(bytes,changedColor)(hdr,hdr),'different');
  assert.ok(inspectionComparator(bytes,changedColor).explain(hdr,hdr).differences.some(x=>x.path.startsWith('HDR gain map → colr')));
}
// The schema-only visible styles summary is insufficient: compare the full plist bytes.
// Mutate only the fixture's existing h scalar, without a production style editor.
const plist = extractItemData(bytes,d,d.stylesItem), trailer = plist.length-32;
const refSize=plist[trailer+7], offsetSize=plist[trailer+6], table=u(plist,trailer+24,8);
const objectOffset = id => u(plist,table+id*offsetSize,offsetSize);
let pos=objectOffset(u(plist,trailer+16,8))+1, count=plist[pos-1]&15;
if(count===15){const size=1<<(plist[pos]&15);count=u(plist,pos+1,size);pos+=1+size;}
let scalar;
for(let i=0;i<count;i++) {
  const key=objectOffset(u(plist,pos+i*refSize,refSize));
  if(plist[key]===0x51 && plist[key+1]===104) scalar=objectOffset(u(plist,pos+(count+i)*refSize,refSize));
}
assert.notEqual(scalar,undefined); assert.ok([0x22,0x23].includes(plist[scalar]));
const customized={data:bytes.slice()}, styleExtent=d.iloc.items.get(d.stylesItem).extents[0];
const start=d.iloc.items.get(d.stylesItem).baseOffset+styleExtent.offset+scalar+1;
const view=new DataView(customized.data.buffer);
if(plist[scalar]===0x22)view.setFloat32(start,3);else view.setFloat64(start,3);
assert.equal(inspectionComparator(bytes,customized.data)(styles,styles),'different');
const styleDiff=inspectionComparator(bytes,customized.data).explain(styles,styles);
assert.equal(styleDiff.differences.length,1); assert.equal(styleDiff.differences[0].path,'styles → fields.h');
assert.equal(styleDiff.differences[0].after,3);
assert.equal(inspectionComparator(bytes,customized.data)(hdr,hdr),'same');
const ratio = row('SkinRatio',undefined,'value');
assert.equal(inspectionComparator(bytes,customized.data)(ratio,ratio),'same');
assert.equal(inspectionComparator(bytes,bytes)({present:true,name:'unsupported'}, {present:true,name:'unsupported'}),'unknown');
assert.ok(equalValues(new Map([['a',1],['b',new Uint8Array([3])]]),new Map([['b',new Uint8Array([3])],['a',1]])));
assert.ok(!equalValues(new Uint8Array([1]),new Uint8Array([2])));
console.log('Exact per-row payload/tile/property/field comparisons and presence states passed');
