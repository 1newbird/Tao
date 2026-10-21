// Read x64 PE import names without depending on a developer's dumpbin install.
export function peImports(bytes) {
  const invalid=()=>{throw new Error("无效或不支持的 x64 PE 导入表");};
  if(bytes.length<64 || bytes.toString('ascii',0,2)!=='MZ')invalid();
  const pe=bytes.readUInt32LE(60),optional=pe+24;
  if(pe+24>bytes.length || bytes.readUInt32LE(pe)!==0x4550 || bytes.readUInt16LE(pe+4)!==0x8664)invalid();
  const optionalSize=bytes.readUInt16LE(pe+20),sections=optional+optionalSize;
  if(optionalSize<128 || sections>bytes.length || bytes.readUInt16LE(optional)!==0x20b)invalid();
  const sectionCount=bytes.readUInt16LE(pe+6),directoryCount=bytes.readUInt32LE(optional+108);
  if(sections+sectionCount*40>bytes.length || 112+directoryCount*8>optionalSize)invalid();
  const offset=rva=>{
    if(rva<bytes.readUInt32LE(optional+60) && rva<bytes.length)return rva;
    for(let index=0;index<sectionCount;index++){
      const section=sections+index*40,delta=rva-bytes.readUInt32LE(section+12);
      if(delta>=0 && delta<bytes.readUInt32LE(section+16)){
        const target=bytes.readUInt32LE(section+20)+delta;if(target<bytes.length)return target;
      }
    }
    return invalid();
  };
  const names=new Set();
  for(const [directory,stride,nameField] of [[1,20,12],[13,32,4]]){
    if(directory>=directoryCount)continue;
    const rva=bytes.readUInt32LE(optional+112+directory*8);if(!rva)continue;
    let cursor=offset(rva),terminated=false;
    for(let index=0;index<1024;index++,cursor+=stride){
      if(cursor+stride>bytes.length)invalid();
      const name=bytes.readUInt32LE(cursor+nameField);
      if(!name){terminated=true;break;}
      if(directory===13 && !(bytes.readUInt32LE(cursor)&1))invalid(); // delay names must be RVAs
      const start=offset(name),end=bytes.indexOf(0,start);
      if(end<start || end-start>260)invalid();
      const value=bytes.toString('ascii',start,end).toLowerCase();
      if(!/^[a-z0-9_.-]+\.dll$/.test(value))invalid();names.add(value);
    }
    if(!terminated)invalid();
  }
  return [...names].sort();
}

export function verifyStaticCrt(bytes) {
  const imports=peImports(bytes),external=imports.filter(name=>/^(?:vcruntime|msvcp|msvcr|concrt)\d.*\.dll$/i.test(name));
  if(external.length)throw new Error(`原生组件仍依赖外部 Visual C++ 运行库：${external.join(', ')}`);
  if(!imports.length)throw new Error("原生组件缺少预期的 Windows DLL 导入表");
  return imports;
}
