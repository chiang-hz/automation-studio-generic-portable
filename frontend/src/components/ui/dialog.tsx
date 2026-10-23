import * as DialogPrimitive from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
import type {ReactNode} from 'react';
export function Dialog({open,onOpenChange,title,description,children,sheet=false}:{open:boolean;onOpenChange:(v:boolean)=>void;title:string;description?:string;children:ReactNode;sheet?:boolean}){
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={!sheet}><DialogPrimitive.Portal>{!sheet&&<DialogPrimitive.Overlay className="ui-overlay"/>}<DialogPrimitive.Content className={sheet?'ui-sheet':'ui-dialog'} onInteractOutside={e=>{if(sheet)e.preventDefault();}} onCloseAutoFocus={e=>{e.preventDefault();document.getElementById('command-open')?.focus();}}><div className="dialog-heading"><div><DialogPrimitive.Title>{title}</DialogPrimitive.Title><DialogPrimitive.Description>{description??'使用 Escape 關閉此面板。'}</DialogPrimitive.Description></div><DialogPrimitive.Close asChild><button className="ui-button ui-ghost h-8 w-8" aria-label="關閉"><X size={18}/></button></DialogPrimitive.Close></div>{children}</DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>;
}
