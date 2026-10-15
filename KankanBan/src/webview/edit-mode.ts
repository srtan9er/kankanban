import {createContext} from 'react';
export const EditMode=createContext<{editable:boolean;busy:boolean;toggle?:()=>void}>({editable:true,busy:false});
