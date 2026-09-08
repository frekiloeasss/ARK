"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function walk(root, prefix = "") {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...walk(root, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}
function sha(file) { const h=createHash("sha256"),fd=fs.openSync(file,"r"),buf=Buffer.allocUnsafe(1024*1024);try{let n;while((n=fs.readSync(fd,buf,0,buf.length,null))>0)h.update(buf.subarray(0,n));}finally{fs.closeSync(fd)}return h.digest("hex"); }
function main() {
  const rootArg=process.argv[2],outArg=process.argv[3];if(!rootArg||!outArg)throw new Error("usage: node build-resource-manifest.js <root> <output>");
  const root=path.resolve(rootArg),output=path.resolve(outArg),files=walk(root).sort();let total=0;
  const entries=files.map((relative,index)=>{const file=path.join(root,relative),stat=fs.statSync(file);total+=stat.size;if(index%500===0)process.stderr.write(`hashed ${index}/${files.length}\n`);return{path:relative.replaceAll("\\","/"),bytes:stat.size,sha256:sha(file)}});
  const aggregate=createHash("sha256").update(entries.map(x=>`${x.sha256} ${x.bytes} ${x.path}\n`).join("")).digest("hex");
  const manifest={version:1,generated_at:new Date().toISOString(),root,file_count:entries.length,total_bytes:total,sha256:aggregate,files:entries};
  fs.mkdirSync(path.dirname(output),{recursive:true});const temp=`${output}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(manifest));fs.renameSync(temp,output);console.log(JSON.stringify({output,file_count:entries.length,total_bytes:total,sha256:aggregate}));
}
main();
