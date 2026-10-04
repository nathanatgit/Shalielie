import assert from 'node:assert/strict';
import fs from 'node:fs';
import {loadProfile} from '../../web/src/zip.js';
import {patch} from '../../web/src/port.js';
import {topBox,be,concat} from '../../web/src/box.js';
import {discoverHeic,extractItemData,auxUriForItem,propertyBoxBytes,dimensionsForItem,removeItems,parseIloc,MATTE_URIS} from '../../web/src/heif.js';
const source=new Uint8Array(fs.readFileSync('tests/private-fixtures/native-style.heic')),sd=discoverHeic(source),profile=await loadProfile(new Uint8Array(fs.readFileSync('web/profiles/45-15.zip')));
const uri=MATTE_URIS.portraiteffectsmatte,idOf=d=>[...d.infos.keys()].find(id=>auxUriForItem(d.props,id)===uri),sid=idOf(sd),[width,height]=dimensionsForItem(sd.props,sid);
const replacement={payload:extractItemData(source,sd,sid),hvcc:propertyBoxBytes(source,sd.props,sid,'hvcC'),pixi:propertyBoxBytes(source,sd.props,sid,'pixi'),width,height};
// A portrait-absent fixture tests the normal patch pipeline, independently of removed UI experiments.
let meta=removeItems(source.slice(sd.meta.off,sd.meta.off+sd.meta.size),new Set([sid]));
const growth=meta.length-sd.meta.size,iloc=parseIloc(meta,topBox(meta,'meta'));
for(const item of iloc.items.values())if(item.constructionMethod===0)for(const e of item.extents)
  meta.set(be(e.offset+growth,iloc.offsetSize),e.offsetPos);
const stripped=concat([source.subarray(0,sd.meta.off),meta,source.subarray(sd.meta.off+sd.meta.size)]);
function verifyPrimaryPreserved(before,after) {
  const a=discoverHeic(before),b=discoverHeic(after);
  for(const [left,right] of [[a.primary,b.primary],...a.primaryTiles.map((id,i)=>[id,b.primaryTiles[i]]),[a.hdrGrid,b.hdrGrid],...a.hdrTiles.map((id,i)=>[id,b.hdrTiles[i]])])
    assert.deepEqual(extractItemData(before,a,left),extractItemData(after,b,right));
}
const absent=await patch(stripped,profile);assert.equal(idOf(discoverHeic(absent.data)),undefined);assert.equal(absent.report.portraitMatte.mode,'omitted-unavailable');verifyPrimaryPreserved(source,absent.data);
const generated=await patch(stripped,profile,{matteOverrides:new Map([[uri,replacement]])}),gd=discoverHeic(generated.data),gid=idOf(gd);
assert.equal(generated.report.portraitMatte.mode,'target-person-segmentation');assert.deepEqual(extractItemData(generated.data,gd,gid),replacement.payload);assert.deepEqual(propertyBoxBytes(generated.data,gd.props,gid,'hvcC'),replacement.hvcc);assert.deepEqual(dimensionsForItem(gd.props,gid),[width,height]);verifyPrimaryPreserved(source,generated.data);
const native=await patch(source,profile,{matteOverrides:new Map([[uri,{...replacement,payload:new Uint8Array([1])}]])}),nd=discoverHeic(native.data),nid=idOf(nd);
assert.equal(native.report.portraitMatte.mode,'native-preserved');assert.deepEqual(extractItemData(native.data,nd,nid),replacement.payload);
const properties=(bytes,d,id)=>(d.props.associations.get(id)||[]).map(a=>{const p=d.props.properties[a.index-1];return {essential:a.essential,bytes:bytes.slice(p.box.off,p.box.off+p.box.size)};});
assert.deepEqual(properties(native.data,nd,nid),properties(source,sd,sid));verifyPrimaryPreserved(source,native.data);
assert.deepEqual(nd.refs.find(r=>r.from===nid&&r.type==='auxl').to,[nd.primary,...[...nd.infos.keys()].filter(id=>nd.infos.get(id).type==='tmap').slice(0,1)]);
await assert.rejects(()=>patch(stripped,profile,{matteOverrides:new Map([[uri,{...replacement,width:0}]])}),/Invalid generated portrait/);
console.log('Portrait matte: no donor placeholder when unavailable; supplied target matte/settings installed; native payload/all properties win over generated override; primary/HDR preserved');
