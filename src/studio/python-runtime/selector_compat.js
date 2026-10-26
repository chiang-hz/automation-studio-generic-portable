/* Automation Studio Selenium selector compatibility, browser-side, no Node.js.
 * Called as (root: Document|Element, css: string) => Element[].
 * Preserve CSS :has(), :nth-child(), :not(), attributes, and DOM ordering.
 * Implement Playwright :has-text(), :text(), :text-is(), :text-matches(), :visible.
 * Reject unsupported nested custom pseudo syntax rather than mis-target.
 */
(root, css) => {
  if (typeof css !== 'string' || !css.trim()) throw Error('Empty selector');
  if (css.length > 5000) throw Error('Selector exceeds length limit');
  const normalize = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const textValue = el => normalize(el.textContent);
  const isVisible = el => {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.visibility !== 'collapse' && !!el.getClientRects().length;
  };
  const dequote = str => {
    str = str.trim();
    if ((str[0] === '"' || str[0] === "'") && str[str.length - 1] === str[0]) {
      try {
        if (str[0] === '"') return JSON.parse(str);
      } catch (_) {}
      return str.slice(1, -1).replace(/\\(['"\\])/g, '$1');
    }
    return str;
  };
  // Scan quote/bracket/parentheses rather than split on regex (quoted selector values may contain spaces/commas).
  const outsideSplit = (input, splitCommas) => {
    const parts = [];
    let buf = '', quote = '', bracket = 0, paren = 0, escaped = false, relation = ' ';
    const push = () => {
      if (buf.trim()) { parts.push({relation, value: buf.trim()}); buf = ''; relation = ' '; }
    };
    for (let i=0; i<input.length; i++) {
      const ch=input[i];
      if (escaped) { buf+=ch; escaped=false; continue; }
      if (ch==='\\') { buf+=ch; escaped=true; continue; }
      if (quote) { buf+=ch; if(ch===quote) quote=''; continue; }
      if (ch==='"' || ch==="'") { quote=ch; buf+=ch; continue; }
      if (ch==='[') { bracket++; buf+=ch; continue; }
      if (ch===']') { bracket--; if(bracket<0) throw Error('Unbalanced CSS brackets'); buf+=ch; continue; }
      if (ch==='(') { paren++; buf+=ch; continue; }
      if (ch===')') { paren--; if(paren<0) throw Error('Unbalanced CSS parentheses'); buf+=ch; continue; }
      if (bracket===0 && paren===0 && (splitCommas ? ch===',' : /\s|>|\+|~/.test(ch))) {
        if (splitCommas) { push(); continue; }
        push();
        if (ch==='>' || ch==='+' || ch==='~') relation=ch;
        else if (relation!=='>' && relation!=='+' && relation!=='~') relation=' ';
        continue;
      }
      buf+=ch;
    }
    if (quote || bracket || paren) throw Error('Unclosed CSS quote/bracket/parenthesis');
    push();
    return parts;
  };
  const extractCompound = value => {
    let base='', filters=[];
    const isNameChar=c=>/[a-zA-Z0-9_-]/.test(c||'');
    for(let i=0;i<value.length;) {
      const known=[':text-matches(',':has-text(',':text-is(',':text(',':visible',':has('];
      const kind=known.find(name=>value.startsWith(name,i) && !isNameChar(value[i+name.length]));
      if (!kind) { base+=value[i++]; continue; }
      if (kind===':visible') {filters.push({kind:'visible'});i+=kind.length;continue;}
      let at=i+kind.length,level=1,quote='',escaped=false,start=at;
      for (;at<value.length;at++) {
        const ch=value[at];
        if(escaped){escaped=false;continue;}
        if(ch==='\\'){escaped=true;continue;}
        if(quote){if(ch===quote)quote='';continue;}
        if(ch==='"'||ch==="'"){quote=ch;continue;}
        if(ch==='(')level++;
        else if(ch===')'){level--;if(!level)break;}
      }
      if (level) throw Error('Unclosed '+kind+' selector');
      const arg=value.slice(start,at);
      if (kind===':has(' && !/:has-text\(|:text\(|:text-is\(|:text-matches\(|:visible\b/.test(arg)) {
        // Native CSS :has() is supported in current Chrome and can retain its semantics.
        base+=value.slice(i,at+1);
      } else {
        filters.push({kind:kind.slice(1,-1),argument:arg});
      }
      i=at+1;
    }
    // Avoid silently changing complex nested selectors containing unsupported Playwright pseudos.
    if (/:has-text\(|:text\(|:text-is\(|:text-matches\(|:visible\b/.test(base)) {
      throw Error('Unsupported nested Playwright selector: '+value);
    }
    return {base:base||'*',filters};
  };
  const uniqueSort = list => {
    const seen = new Set();
    return list.filter(el=>{ if(seen.has(el)) return false;seen.add(el);return true; })
      .sort((a,b)=>a===b?0:a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);
  };
  const select = (scope, expression, depth=0) => {
    if(depth>5) throw Error('Nested :has depth limit exceeded');
    const output=[];
    for (const group of outsideSplit(expression,true)) {
      let current=[scope];
      const segments=outsideSplit(group.value,false);
      for (const [i,seg] of segments.entries()) {
        const {base,filters}=extractCompound(seg.value);
        let next=[];
        for (const parent of current) {
          if (i===0 && seg.relation===' ' || seg.relation===' ' && i>0) {
            next.push(...parent.querySelectorAll(base));
          } else if (seg.relation==='>') {
            next.push(...[...parent.children].filter(el=>el.matches(base)));
          } else if (seg.relation==='+') {
            const sib=parent.nextElementSibling;
            if(sib && sib.matches(base))next.push(sib);
          } else if (seg.relation==='~') {
            for(let sib=parent.nextElementSibling;sib;sib=sib.nextElementSibling) if(sib.matches(base))next.push(sib);
          } else { next.push(...parent.querySelectorAll(base)); }
        }
        next=uniqueSort(next);
        for(const filter of filters) {
          const v=dequote(filter.argument||'');
          if(filter.kind==='visible') next=next.filter(isVisible);
          else if(filter.kind==='has-text') next=next.filter(el=>textValue(el).toLowerCase().includes(v.toLowerCase()));
          else if(filter.kind==='text-is') next=next.filter(el=>textValue(el)===v);
          else if(filter.kind==='text') next=next.filter(el=>textValue(el).toLowerCase().includes(v.toLowerCase()) &&
            ![...el.children].some(c=>textValue(c).toLowerCase().includes(v.toLowerCase())));
          else if(filter.kind==='text-matches') {
            const args=outsideSplit(filter.argument,true).map(p=>dequote(p.value));
            let pattern;
            try { pattern=new RegExp(args[0],args[1]||''); }
            catch(e){throw Error('Invalid :text-matches regex: '+e.message);}
            next=next.filter(el=>pattern.test(textValue(el)));
          } else if(filter.kind==='has') next=next.filter(el=>select(el,filter.argument,depth+1).length>0);
          else throw Error('Unsupported selector filter: '+filter.kind);
        }
        current=next;
        if(!current.length) break;
      }
      output.push(...current);
    }
    return uniqueSort(output);
  };
  return select(root,css);
}
