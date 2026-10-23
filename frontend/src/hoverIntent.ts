export const PALETTE_HOVER_DELAY_MS=800;
export function createHoverIntent(reveal:()=>void,hide:()=>void){
  let timer:ReturnType<typeof setTimeout>|undefined;
  const cancel=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;};
  return {
    enter(){cancel();timer=setTimeout(()=>{timer=undefined;reveal();},PALETTE_HOVER_DELAY_MS);},
    leave(){cancel();hide();},
    dispose(){cancel();}
  };
}
