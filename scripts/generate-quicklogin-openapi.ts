import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source = readFileSync('src/services/quicklogin/protocol-v3.ts','utf8');
const ast = ts.createSourceFile('protocol-v3.ts',source,ts.ScriptTarget.Latest,true);
type Schema = Record<string, unknown>;
const declarations = new Map<string, ts.Node>();
for(const statement of ast.statements){
 if(ts.isInterfaceDeclaration(statement)||ts.isTypeAliasDeclaration(statement))declarations.set(statement.name.text,statement);
 if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations) if(ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text,declaration);
}
function convert(node: ts.TypeNode): Schema {
 if(node.kind===ts.SyntaxKind.StringKeyword)return {type:'string'};
 if(node.kind===ts.SyntaxKind.NumberKeyword)return {type:'number'};
 if(node.kind===ts.SyntaxKind.BooleanKeyword)return {type:'boolean'};
 if(ts.isLiteralTypeNode(node)){ if(node.literal.kind===ts.SyntaxKind.NullKeyword)return {type:'null'}; if(ts.isStringLiteral(node.literal))return {type:'string',const:node.literal.text};if(ts.isNumericLiteral(node.literal))return{type:'number',const:Number(node.literal.text)}; }
 if(ts.isUnionTypeNode(node)){
  const parts=node.types.map(convert);
  if(parts.every(part=>part.type==='null'||typeof part.const==='string')){
   const nullable=parts.some(part=>part.type==='null');
   return {type:nullable?['string','null']:'string',enum:parts.map(part=>part.type==='null'?null:part.const)};
  }
  return {anyOf:parts};
 }
 if(ts.isArrayTypeNode(node))return{type:'array',items:convert(node.elementType)};
 if(ts.isTypeLiteralNode(node))return members(node.members);
 if(ts.isTypeReferenceNode(node)){
  const name=node.typeName.getText(ast);
  if(name==='ApiResponse')return{type:'object',required:['data','meta'],properties:{data:convert(node.typeArguments![0]!),meta:{$ref:'#/components/schemas/QuickloginV3ApiMeta'}}};
  if(!declarations.has(name))throw new Error(`Unknown type ${name}`);
  return{$ref:`#/components/schemas/QuickloginV3${name}`};
 }
 if(ts.isIndexedAccessTypeNode(node)&&ts.isTypeQueryNode(node.objectType)){
  const declaration=declarations.get(node.objectType.exprName.getText(ast));
  if(!declaration||!ts.isVariableDeclaration(declaration))throw new Error('Missing constant');
  const init=declaration.initializer;
  const array=init&&ts.isAsExpression(init)?init.expression:init;
  if(array&&ts.isArrayLiteralExpression(array))return{type:'string',enum:array.elements.map(e=>(e as ts.StringLiteral).text)};
 }
 throw new Error(`Unsupported wire type ${node.getText(ast)}`);
}
function members(nodes: ts.NodeArray<ts.TypeElement>):Schema{
 const properties:Record<string,Schema>={},required:string[]=[];
 for(const member of nodes){if(!ts.isPropertySignature(member)||!member.type||!member.name)throw new Error('Invalid wire member');const name=member.name.getText(ast);properties[name]=convert(member.type);if(!member.questionToken)required.push(name);}
 return{type:'object',required,properties};
}
const roots=['Capabilities','RegistrationRequest','RegistrationResponse','ReconcileRequest','ReconcileResponse','OperationRequest','OperationResponse','ExportRequest','ExportEnvelope','ReceiptRequest','ReceiptAck','Overview','ApiProblem','ApiMeta'];
const schemas:Record<string,Schema>={};
const needed=[...roots];
for(let i=0;i<needed.length;i++){
 const name=needed[i]!,node=declarations.get(name);let schema:Schema;
 if(node&&ts.isInterfaceDeclaration(node)){
  schema=members(node.members);
  if(node.heritageClauses){const allOf=node.heritageClauses.flatMap(h=>h.types.map(t=>({$ref:`#/components/schemas/QuickloginV3${t.expression.getText(ast)}`})));schema={allOf:[...allOf,schema]};}
 }else if(node&&ts.isTypeAliasDeclaration(node))schema=convert(node.type);else throw new Error(`No wire declaration ${name}`);
 schemas[`QuickloginV3${name}`]=schema;
 const refs=JSON.stringify(schema).matchAll(/#\/components\/schemas\/QuickloginV3([A-Za-z]+)/g);for(const ref of refs)if(!needed.includes(ref[1]!))needed.push(ref[1]!);
}
const digest=createHash('sha256').update(source).digest('hex');
writeFileSync('src/api/openapi/quicklogin-v3.generated.ts',`// Generated from canonical protocol-v3.ts; SHA-256 ${digest}\nexport const QUICKLOGIN_V3_SCHEMAS: Record<string, Record<string, unknown>> = ${JSON.stringify(schemas,null,2)};\n`);
