import fs from 'node:fs'
const ASAR = 'D:/DeepSeek Harness/resources/app.asar'
function idx(f){const fd=fs.openSync(f,'r');const h=Buffer.alloc(16);fs.readSync(fd,h,0,16,0);const n=h.readUInt32LE(12);const j=Buffer.alloc(n);fs.readSync(fd,j,0,n,16);return {fd,index:JSON.parse(j.toString('utf8')),dataStart:16+n+((4-((16+n)%4))%4)}}
function walk(node,p,out){for(const [k,v] of Object.entries(node.files??{})){const q=p?p+'/'+k:k;if(v.files)walk(v,q,out);else out.push({path:q,size:v.size,offset:v.offset})}}
const {fd,index,dataStart}=idx(ASAR);const all=[];walk(index,'',all)
const read=(e)=>{const b=Buffer.alloc(Number(e.size));fs.readSync(fd,b,0,b.length,dataStart+Number(e.offset));return b.toString('utf8')}
let n=0
for(const f of all){
  if(!/\.(js|mjs|cjs|json)$/.test(f.path)) continue
  if(f.size>4_000_000) continue
  let s; try{ s=read(f) }catch{ continue }
  if(/presets\/\$\{|presets['"`]|presetDir|presetPatch|loadPresets|presetFiles/.test(s)){
    n++
    if(n<=8){
      console.log('★ '+f.path)
      for(const re of [/presets\/[\s\S]{0,80}/g,/presetFiles[\s\S]{0,80}/g,/loadPresets[\s\S]{0,80}/g]){
        const m=s.match(re); if(m) console.log('   ' + m[0].replace(/\s+/g,' ').slice(0,110))
      }
    }
  }
}
console.log('命中文件数:', n)
fs.closeSync(fd)
