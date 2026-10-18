import { createHash } from 'node:crypto';
import { mkdir, lstat, realpath, open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join, parse, extname } from 'node:path';
import { homedir } from 'node:os';
export { containsCredential } from './core.mjs';
import { containsCredential } from './core.mjs';

const LIMIT = 16 * 1024;
const WRITABLE = new Set(['.txt','.md','.json','.csv','.tsv','.yaml','.yml','.xml','.log','.rst']);
const forbidden = /^(?:\.git|\.codex|\.ssh|\.aws|\.azure|\.config|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.docker|\.kube|\.gnupg|node_modules|appdata|windows|program files(?: \(x86\))?|\.env(?:\..*)?|credentials?(?:\..*)?|auth(?:\..*)?|config\.toml|opencode\.jsonc?|package(?:-lock)?\.json|agents\.md|.*\.(?:pem|key|pfx|p12|exe|dll|lnk))$/i;
const fail = code => { throw new Error(code); };
export const hashBytes = value => createHash('sha256').update(value).digest('hex');
const equalPath = (a,b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const below = (a,b) => { const rel=relative(a,b); return rel && !rel.startsWith('..') && !isAbsolute(rel); };
const abort = signal => { if(signal?.aborted) fail('agent_cancelled'); };

export function safeRelativePath(value) {
  if(typeof value!=='string' || value.length<1 || value.length>240 || /[\\:\x00-\x1f<>"|?*]/.test(value) || isAbsolute(value)) fail('agent_path_denied');
  const parts=value.split('/');
  if(parts.some(part=>!part || part==='.' || part==='..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || forbidden.test(part))) fail('agent_path_denied');
  return value;
}

// Walk every ancestor; selected files may not be symlinks, junctions or hardlinks.
async function checkedPath(root, name, allowMissing=false) {
  safeRelativePath(name);
  await directoryChain(root);
  const rootStat=await lstat(root);
  if(rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('agent_path_denied');
  let current=root;
  const parts=name.split('/');
  for(let i=0;i<parts.length;i++) {
    current=join(current,parts[i]);
    let stat;
    try { stat=await lstat(current); } catch(e) { if(e.code==='ENOENT' && allowMissing) return {path:join(root,...parts),exists:false}; throw e; }
    if(stat.isSymbolicLink() || (i<parts.length-1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink!==1)) fail('agent_path_denied');
    if(!below(root,await realpath(current))) fail('agent_path_denied');
  }
  return {path:current,exists:true};
}

async function directoryChain(path) {
  let cursor=resolve(path);
  while(true) {
    const info=await lstat(cursor);
    if(info.isSymbolicLink() || !info.isDirectory()) fail('agent_path_denied');
    const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;
  }
}

async function readChecked(root,name,allowMissing=false) {
  const target=await checkedPath(root,name,allowMissing);
  if(!target.exists) return {hash:null,content:null,bytes:0};
  const handle=await open(target.path,'r');
  try {
    const before=await handle.stat();
    if(!before.isFile() || before.nlink!==1 || before.size>LIMIT) fail('agent_file_limit');
    const data=await handle.readFile();
    const after=await handle.stat();
    const visible=await lstat(target.path);
    await checkedPath(root,name);
    if(data.length>LIMIT || ['ino','dev','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]||after[key]!==visible[key])
      || visible.isSymbolicLink() || visible.nlink!==1) fail('agent_file_changed');
    let content; try { content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data); } catch { fail('agent_text_required'); }
    if(content.includes('\0') || containsCredential(content)) fail('agent_sensitive_file');
    return {hash:hashBytes(data),content,bytes:data.length};
  } finally { await handle.close(); }
}

export class AgentWorkspace {
  constructor(manifest,taskDirectory) {
    this.manifest=manifest; this.taskDirectory=taskDirectory;
    this.directory=join(taskDirectory,'workspace'); this.projectDirectory=manifest.projectDirectory;
  }
  static async create({projectDirectory,readFiles,writeFiles,stateDir,taskId}) {
    if(typeof taskId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(taskId)) fail('agent_task_id_invalid');
    if(typeof projectDirectory!=='string' || !isAbsolute(projectDirectory) || projectDirectory.startsWith('\\\\')) fail('agent_project_denied');
    const project=resolve(projectDirectory), canonical=await realpath(project);
    if(!equalPath(project,canonical) || equalPath(project,parse(project).root) || equalPath(project,homedir())
      || project.split(/[\\/]/).some(part=>forbidden.test(part))) fail('agent_project_denied');
    const rootInfo=await lstat(project); if(!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('agent_project_denied');
    for(const files of [readFiles,writeFiles]) if(!Array.isArray(files)||files.length>8 || new Set(files.map(p=>typeof p==='string'?p.toLowerCase():p)).size!==files.length) fail('agent_scope_invalid');
    const reads=readFiles.map(safeRelativePath),writes=writeFiles.map(safeRelativePath);
    if(!reads.length&&!writes.length) fail('agent_scope_empty');
    if(writes.some(p=>!WRITABLE.has(extname(p).toLowerCase()))) fail('agent_write_type_denied');
    const all=[...new Set([...reads,...writes])];
    if(new Set(all.map(p=>p.toLowerCase())).size!==all.length) fail('agent_scope_invalid');
    const originals={}; let total=0;
    for(const name of all) {
      const entry=await readChecked(project,name,writes.includes(name));
      if(entry.hash!==null && !reads.includes(name)) fail('agent_existing_write_requires_read');
      if(entry.hash===null && reads.includes(name)) fail('agent_read_missing');
      total+=entry.bytes; if(total>32*1024) fail('agent_total_limit');
      originals[name]=entry;
    }
    const taskDirectory=join(resolve(stateDir),'agent-tasks',taskId);
    await mkdir(taskDirectory,{recursive:true});
    await directoryChain(taskDirectory);
    const manifest={projectDirectory:project,readFiles:reads,writeFiles:writes,originals};
    const instance=new AgentWorkspace(manifest,taskDirectory);
    await mkdir(instance.directory,{recursive:true});
    for(const [name,entry] of Object.entries(originals)) if(entry.hash!==null) {
      const path=join(instance.directory,name); await mkdir(dirname(path),{recursive:true});
      await writeFile(path,entry.content,{encoding:'utf8',flag:'wx'});
    }
    await writeFile(join(taskDirectory,'manifest.json'),JSON.stringify(manifest),{flag:'wx'});
    return instance;
  }
  static async load(taskDirectory) {
    const raw=await readFile(join(taskDirectory,'manifest.json'),'utf8');
    if(raw.length>100000) fail('agent_manifest_invalid');
    return new AgentWorkspace(JSON.parse(raw),taskDirectory);
  }
  async read(path) {
    safeRelativePath(path);
    if(!this.manifest.readFiles.includes(path)&&!this.manifest.writeFiles.includes(path)) fail('agent_file_not_selected');
    const value=await readChecked(this.directory,path);
    return {path,content:value.content,bytes:value.bytes};
  }
  async write(path,content) {
    safeRelativePath(path);
    if(!this.manifest.writeFiles.includes(path)) fail('agent_write_not_selected');
    if(typeof content!=='string' || Buffer.byteLength(content)>LIMIT || content.includes('\0')) fail('agent_file_limit');
    if(containsCredential(content)) fail('agent_sensitive_output');
    const target=await checkedPath(this.directory,path,true);
    await mkdir(dirname(target.path),{recursive:true});
    await checkedPath(this.directory,path,true);
    await writeFile(target.path,content,'utf8');
    return {path,bytes:Buffer.byteLength(content)};
  }
  async changes() {
    const changes=[];
    for(const path of this.manifest.writeFiles) {
      const data=await readChecked(this.directory,path,true),original=this.manifest.originals[path];
      if(data.hash!==null && data.hash!==original.hash) changes.push({path,content:data.content,bytes:data.bytes,originalHash:original.hash,hash:data.hash});
    }
    return changes;
  }
  async verifyOriginals() {
    for(const [path,original] of Object.entries(this.manifest.originals)) {
      const actual=await readChecked(this.projectDirectory,path,true);
      if(actual.hash!==original.hash) fail('agent_original_changed');
    }
  }
  async apply(changes,{signal}={}) {
    abort(signal); await this.verifyOriginals(); abort(signal);
    const expected=await this.changes();
    if(JSON.stringify(expected)!==JSON.stringify(changes)) fail('agent_candidate_changed');
    const applied=[];
    try {
      for(const item of changes) {
        abort(signal); await this.verifyOriginalsExcept(applied); abort(signal);
        const target=await checkedPath(this.projectDirectory,item.path,true);
        await mkdir(dirname(target.path),{recursive:true});
        await checkedPath(this.projectDirectory,item.path,true); abort(signal);
        if(item.originalHash===null) {
          const handle=await open(target.path,'wx');let completed=false;
          try {await handle.writeFile(item.content,'utf8');completed=true;}
          finally {await handle.close();if(!completed)await unlink(target.path);}
        }
        else {
          const temp=target.path+'.agent-'+hashBytes(item.content).slice(0,16)+'.tmp';
          try { await writeFile(temp,item.content,{encoding:'utf8',flag:'wx'}); abort(signal); await this.verifyOriginalsExcept(applied); await rename(temp,target.path); }
          finally { await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
        }
        applied.push(item);
      }
      abort(signal);
      return {applied:applied.map(item=>item.path)};
    } catch(error) {
      let recovery=false;
      for(const item of applied.reverse()) {
        try {
          const current=await readChecked(this.projectDirectory,item.path,true);
          if(current.hash!==item.hash) { recovery=true;continue; }
          const target=await checkedPath(this.projectDirectory,item.path);
          if(item.originalHash===null) await unlink(target.path);
          else await writeFile(target.path,this.manifest.originals[item.path].content,'utf8');
        } catch { recovery=true; }
      }
      if(recovery) fail('agent_recovery_required');
      throw error;
    }
  }
  async verifyOriginalsExcept(applied) {
    for(const [path,original] of Object.entries(this.manifest.originals)) {
      const expected=applied.find(item=>item.path===path)?.hash??original.hash;
      if((await readChecked(this.projectDirectory,path,true)).hash!==expected) fail('agent_original_changed');
    }
  }
}
