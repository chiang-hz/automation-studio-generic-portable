import {bridge} from './bridge';
import {createStudioStore} from './studioState';
export const useStudio=createStudioStore(bridge,localStorage);
bridge.subscribe(()=>useStudio.getState().refresh());
