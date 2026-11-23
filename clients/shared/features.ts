import type { Account } from './api.ts';
export type Field = { name: string; label: string; type?: 'number'|'date'|'file'|'password'|'email'; optional?: boolean; options?: string[] };
export type Action = { id: string; label: string; path: string; method?: string; fields?: Field[]; binary?: string; event?: boolean };
const f = (name: string, label: string, type?: Field['type'], optional?: boolean): Field => ({name,label,type,optional});
const select = (name: string,label: string,options: string[]): Field => ({name,label,options});
const moto = f('motorcycleId','ID de motocicleta');
const shop = f('workshopId','ID de taller');
const details = [f('plate','Placa'),f('make','Marca'),f('model','Modelo')];
export const panels = [
  {id:'vehicles', label:'Motocicletas', actions:[
    {id:'motos',label:'Mis motocicletas',path:'/api/core/motorcycles'},
    {id:'create',label:'Registrar motocicleta',path:'/api/core/motorcycles',method:'POST',fields:details},
    {id:'edit',label:'Editar motocicleta',path:'/api/core/motorcycles/{motorcycleId}',method:'PATCH',fields:[moto,...details]},
    {id:'delete',label:'Eliminar motocicleta',path:'/api/core/motorcycles/{motorcycleId}',method:'DELETE',fields:[moto]},
    {id:'odo',label:'Actualizar odómetro',path:'/api/core/motorcycles/{motorcycleId}/odometer',method:'PATCH',fields:[moto,f('kilometers','Kilómetros','number')]},
    {id:'history',label:'Consultar historial',path:'/api/core/motorcycles/{motorcycleId}/events',fields:[moto]},
    {id:'event',label:'Registrar gasto o mantenimiento',path:'/api/core/motorcycles/{motorcycleId}/events',method:'POST',event:true,fields:[moto,select('kind','Tipo',['MAINTENANCE','EXPENSE']),f('category','Categoría'),f('description','Descripción'),f('amountCop','Importe COP','number'),f('occurredAt','Fecha','date')]},
  ]},
  {id:'documents',label:'Documentos y alertas',actions:[
    {id:'docs',label:'Consultar documentos',path:'/api/notify/documents/{motorcycleId}',fields:[moto]},
    {id:'upload',label:'Subir documento',path:'/api/notify/documents/{motorcycleId}',method:'POST',fields:[moto,f('file','Archivo','file')]},
    {id:'download',label:'Descargar documento',path:'/api/notify/documents/{motorcycleId}/{documentId}',fields:[moto,f('documentId','ID de documento')],binary:'documento.bin'},
    {id:'notifications',label:'Notificaciones',path:'/api/notify/notifications'},
    {id:'reminders',label:'Recordatorios',path:'/api/notify/reminders'},
    {id:'remind',label:'Crear recordatorio',path:'/api/notify/reminders',method:'POST',fields:[moto,f('dueAt','Vencimiento','date',true),f('kilometers','Kilómetros','number',true)]},
    ...['csv','pdf'].map(format=>({id:'report-'+format,label:'Descargar historial '+format.toUpperCase(),path:'/api/notify/reports/motorcycles/{motorcycleId}/'+format,fields:[moto],binary:'historial.'+format})),
  ]},
  {id:'analytics',label:'Analítica',actions:[
    ...[['tco','Costo registrado'],['maintenance','Preventivos y correctivos'],['recommendation','Próximo mantenimiento']].map(([slug,label])=>({id:slug,label,path:'/api/analytics/motorcycles/{motorcycleId}/'+slug,fields:[moto]})),
    {id:'monthly',label:'Gastos mensuales',path:'/api/analytics/monthly',fields:[select('dimension','Agrupar por',['category','make','workshop']),f('since','Desde','date',true),f('until','Hasta (excluido)','date',true)]},
  ]},
  {id:'workshop',label:'Taller y facturas',actions:[
    {id:'shops',label:'Consultar talleres',path:'/api/core/workshops'},
    {id:'shop-add',label:'Crear taller',path:'/api/core/workshops',method:'POST',fields:[f('name','Nombre'),f('documentId','Documento')]},
    {id:'products',label:'Consultar catálogo',path:'/api/core/workshops/{workshopId}/products',fields:[shop]},
    {id:'sku',label:'Registrar producto',path:'/api/core/workshops/{workshopId}/products',method:'POST',fields:[shop,f('sku','SKU'),f('name','Nombre')]},
    {id:'invoices',label:'Consultar facturas',path:'/api/core/workshops/{workshopId}/invoices',fields:[shop]},
    {id:'invoice',label:'Emitir factura',path:'/api/core/workshops/{workshopId}/invoices',method:'POST',fields:[shop,moto,f('series','Serie'),f('invoiceNumber','Número de factura','number'),f('amountCop','Importe COP','number')]},
  ]},
  {id:'admin',label:'Administración',actions:[
    {id:'role',label:'Asignar rol',path:'/api/core/admin/users/{userId}/role',method:'PATCH',fields:[f('userId','ID de cuenta'),select('role','Rol',['RIDER','WORKSHOP_ADMIN','SUPER_ADMIN']),f('workshopId','ID de taller',undefined,true)]},
    {id:'cache',label:'Métricas Redis',path:'/api/core/admin/cache-metrics'},
    {id:'audit',label:'Auditoría Cassandra',path:'/api/core/admin/audit',fields:[f('day','Día UTC','date',true)]},
  ]},
] satisfies {id:string;label:string;actions:Action[]}[];
export function accountPanels(account: Account) {
  return panels.filter(p=> (p.id !== 'workshop' || account.role !== 'RIDER') &&
    (p.id !== 'admin' || account.role === 'SUPER_ADMIN')).map(p=>({...p,actions:(p.actions as Action[])
    .filter(a=> !(account.role === 'WORKSHOP_ADMIN' && ['create','delete','shop-add'].includes(a.id)))}));
}
export function prepare(action: Action, values: Record<string,string>, file?: FormData) {
  const errors: Record<string,string> = {};
  const body: Record<string,unknown> = {};
  let path=action.path;
  const query = new URLSearchParams();
  for(const field of action.fields ?? []) {
    const value=values[field.name]??'';
    const raw=field.type==='password'?value:value.trim();
    if(field.type === 'file') { if(!file) errors[field.name]='Selecciona un archivo.'; continue; }
    if(!raw) { if(!field.optional) errors[field.name]='Completa este campo.'; continue; }
    if(field.type === 'number' && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) { errors[field.name]='Escribe un entero válido.'; continue; }
    if(field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) { errors[field.name]='Usa el formato AAAA-MM-DD.'; continue; }
    const key='{'+field.name+'}';
    if(path.includes(key)) {
      if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(raw)) errors[field.name]='Escribe un ID válido.';
      path=path.replace(key,encodeURIComponent(raw));
    } else if(!action.method) query.set(field.name,raw);
    else if(field.type==='number') body[field.name]=Number(raw);
    else if(field.type==='date') body[field.name]=raw+'T12:00:00.000Z';
    else body[field.name]=raw;
  }
  if(action.id==='remind' && !body.dueAt && body.kilometers === undefined) errors.dueAt='Elige fecha o kilometraje.';
  const suffix=query.toString();
  return {errors,path:path+(suffix?'?'+suffix:''),body:file ?? (action.method==='DELETE' || !action.method?undefined:body)};
}
