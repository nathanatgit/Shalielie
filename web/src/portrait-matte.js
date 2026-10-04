import {parseIinf,parseIref,parseIpcoIpma,auxUriForItem,extractItemData,appendIpcoProperty,setItemPropertyAssociations,setItemReference,addItems,removeItems,ispeBox,auxcBox,MATTE_URIS,findItemsByType} from './heif.js?v=0.6.0-web';
import {topBox,bytesEqual} from './box.js?v=0.6.0-web';

/** Do not pass a donor portrait effect matte off as target-derived data. */
export function installPortraitMatte(meta,payloads,targetData=null,target=null,generated=null,primary=null) {
  const uri=MATTE_URIS.portraiteffectsmatte,props=parseIpcoIpma(meta,topBox(meta,'meta')),infos=parseIinf(meta,topBox(meta,'meta')),refs=parseIref(meta,topBox(meta,'meta'));
  const existing=[...infos.keys()].filter(id=>auxUriForItem(props,id)===uri),native=target?[...target.infos.keys()].find(id=>auxUriForItem(target.props,id)===uri):undefined;
  if(native===undefined&&!generated){
    const removed=new Set(existing);for(const r of refs)if(r.type==='cdsc'&&r.to.length&&r.to.every(id=>removed.has(id)))removed.add(r.from);
    if(removed.size)meta=removeItems(meta,removed);for(const id of removed)payloads.delete(id);
    return {meta,report:{mode:'omitted-unavailable',donorPlaceholderUsed:false,removedItems:[...removed]}};
  }
  if(primary==null)throw Error('Portrait matte requires explicit primary');
  return install(meta,payloads,targetData,target,generated,native,existing,props,primary);
}
function install(meta,payloads,source,target,generated,native,existing,props,primary) {
  const uri=MATTE_URIS.portraiteffectsmatte;
  const originalMeta=meta;
  let id=existing[0];
  if(id===undefined){let assigned;[meta,assigned]=addItems(meta,[{key:'portrait',itemType:'hvc1'}]);id=assigned.get('portrait');}
  let values,payload;
  if(native!==undefined){
    if(target.infos.get(native)?.type!=='hvc1')throw Error('Native portrait matte requires a direct HEVC item');
    payload=extractItemData(source,target,native);values=(target.props.associations.get(native)||[]).map(a=>{const p=target.props.properties[a.index-1];return {bytes:source.slice(p.box.off,p.box.off+p.box.size),essential:a.essential};});
  }else{
    if(!generated.payload?.length||!generated.hvcc||!generated.pixi||!Number.isInteger(generated.width)||!Number.isInteger(generated.height)||generated.width<=0||generated.height<=0)throw Error('Invalid generated portrait matte');
    payload=generated.payload;
    values=(props.associations.get(id)||[]).filter(a=>!['ispe','pixi','hvcC','auxC'].includes(props.properties[a.index-1].type)).map(a=>{const p=props.properties[a.index-1];return {bytes:originalMeta.slice(p.box.off,p.box.off+p.box.size),essential:a.essential};});
    values.push({bytes:ispeBox(generated.width,generated.height),essential:false},{bytes:generated.pixi,essential:false},{bytes:auxcBox(uri),essential:true},{bytes:generated.hvcc,essential:true});
    if(!existing.length)values.push(...(props.associations.get(primary)||[]).filter(a=>['irot','imir'].includes(props.properties[a.index-1].type)).map(a=>{const p=props.properties[a.index-1];return {bytes:originalMeta.slice(p.box.off,p.box.off+p.box.size),essential:a.essential};}));
    const transform=p=>['irot','imir'].includes(String.fromCharCode(...p.bytes.slice(4,8)));
    values=[...values.filter(p=>!transform(p)),...values.filter(transform)];
  }
  const associations=[];for(const p of values){const current=parseIpcoIpma(meta,topBox(meta,'meta'));let index=current.properties.find(v=>bytesEqual(meta.slice(v.box.off,v.box.off+v.box.size),p.bytes))?.index;if(index===undefined)[meta,index]=appendIpcoProperty(meta,p.bytes);associations.push([index,p.essential]);}
  meta=setItemPropertyAssociations(meta,id,associations);payloads.set(id,payload);
  meta=setItemReference(meta,'auxl',id,[primary,...findItemsByType(parseIinf(meta,topBox(meta,'meta')),'tmap').slice(0,1)]);
  return {meta,report:{mode:native!==undefined?'native-preserved':'target-person-segmentation',itemId:id,sourceItemId:native??null,donorPlaceholderUsed:false,width:generated?.width,height:generated?.height}};
}
