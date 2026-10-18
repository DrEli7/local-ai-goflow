// Trusted, read-only command implementations. This file never imports project code.
import { readFile } from 'node:fs/promises';
const [kind,path]=process.argv.slice(2);
try {
  if(!['text_stats','json_validate','csv_stats'].includes(kind)) throw new Error('unsupported');
  const bytes=await readFile(path);
  if(bytes.length>16384) throw new Error('too_large');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  let result;
  if(kind==='text_stats') result={bytes:bytes.length,unicodeCodePoints:[...text].length,lines:text?text.split(/\r?\n/).length:0};
  if(kind==='json_validate') {
    const value=JSON.parse(text);
    result={valid:true,type:value===null?'null':Array.isArray(value)?'array':typeof value,
      entries:Array.isArray(value)?value.length:value&&typeof value==='object'?Object.keys(value).length:1};
  }
  if(kind==='csv_stats') {
    const rows=[];let row=[],field='',quoted=false,afterQuote=false;
    for(let i=0;i<text.length;i++) {
      const c=text[i];
      if(quoted) { if(c==='"') { if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;afterQuote=true;} }else field+=c; continue; }
      if(c==='"') { if(field||afterQuote)throw new Error('bad_csv');quoted=true;continue; }
      if(c===','){row.push(field);field='';afterQuote=false;continue;}
      if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);rows.push(row);row=[];field='';afterQuote=false;continue;}
      if(afterQuote)throw new Error('bad_csv');field+=c;
    }
    if(quoted)throw new Error('bad_csv');
    if(field||row.length||afterQuote){row.push(field);rows.push(row);}
    result={rows:rows.length,dataRows:Math.max(0,rows.length-1),columns:rows[0]?.length??0,
      consistent:rows.every(value=>value.length===(rows[0]?.length??0))};
  }
  process.stdout.write(JSON.stringify(result)+'\n');
} catch { process.stderr.write('selected_file_check_failed\n');process.exitCode=1; }
