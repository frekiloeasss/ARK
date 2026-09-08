"use strict";
const fs=require("node:fs"),path=require("node:path"),{createHash}=require("node:crypto");const root=path.resolve(__dirname,"..");
function sha(file){return createHash("sha256").update(fs.readFileSync(file)).digest("hex")}
function collect(directory,extension,prefix=""){const rows=[];for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const relative=path.join(prefix,entry.name),file=path.join(directory,entry.name);if(entry.isDirectory())rows.push(...collect(file,extension,relative));else if(entry.name.endsWith(extension)&&!entry.name.startsWith("manifest-")){const stat=fs.statSync(file);rows.push({name:relative.replaceAll("\\","/"),bytes:stat.size,sha256:sha(file)})}}return rows.sort((a,b)=>a.name.localeCompare(b.name))}
const configs=collect(path.join(root,"data/official/client-full"),".json"),scripts=collect(path.join(root,"data/official/client-scripts"),".js");
const aggregate=createHash("sha256").update([...configs.map(x=>`config ${x.sha256} ${x.name}`),...scripts.map(x=>`script ${x.sha256} ${x.name}`)].join("\n")).digest("hex");
const manifest={version:1,client_version:"1.182.03.301371",generated_at:new Date().toISOString(),config_count:configs.length,script_count:scripts.length,sha256:aggregate,configs,scripts};
fs.writeFileSync(path.join(root,"runtime/client-evidence-manifest.json"),JSON.stringify(manifest,null,2)+"\n");console.log(JSON.stringify({config_count:configs.length,script_count:scripts.length,sha256:aggregate}));
