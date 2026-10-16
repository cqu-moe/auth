import {execFileSync} from 'node:child_process';
import {browserBase} from './image.mjs';
execFileSync('docker',['build','--platform','linux/amd64','-t',browserBase(),'./container'],{stdio:'inherit'});
