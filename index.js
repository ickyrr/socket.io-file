"use strict";
const EventEmitter = require('events').EventEmitter;
const util = require('util');
const fs = require('fs');
const path = require('path');

const CHUNK_SIZE = 524288;
const MAX_BUFFER_SIZE = 10485760;

function mkdirSyncRecursively(dir, mode) {
    try {
        var result = fs.mkdirSync(dir, mode);
    }
    catch(e) {
        if(e.code === 'ENOENT') {
            mkdirSyncRecursively(path.dirname(dir), mode);  // if does not exists, create all parents recursively
            mkdirSyncRecursively(dir, mode);   // retry
        }
    }
}

function SocketIOFile(socket, options) {
    const self = this;
    const clients = {};
    const files = {};

    options = options || {};

	this.socket = socket;
    this.uploadDir = '';

    var sendError = (err) => {
        this.socket.emit('socket.io-file::error', err);
        this.emit('error', err);
    };

    // create upload dir if not exists
    if(options.uploadDir) {
        let dir = options.uploadDir;

        function createDirectoryIfNotExists(dir) {
            try {
                fs.accessSync(dir, fs.F_OK);
            }
            catch(e) {
                // create directory if not exists
                mkdirSyncRecursively(dir, '0755');
            }
        }

        if(typeof options.uploadDir === 'string') {
            createDirectoryIfNotExists(dir);
        }
        else if(typeof options.uploadDir === 'object') {
            for(var key in options.uploadDir) {
                createDirectoryIfNotExists(options.uploadDir[key]);
            }
        }
        else {
            return sendError('options.uploadDir must be string or object array.');
        }

        this.uploadDir = dir;
    }

    this.socket.on('socket.io-file::sync', (data) => {
        clients[data.id] = true;

        this.socket.emit('socket.io-file::sync', {
            done: true
        });
    });

	this.socket.on('socket.io-file::start', (data) => {
        let id = data.id;
		let fileName = data.name;
        let uploadDir;
        let uploadTo = data.uploadTo;
        let uploadData = data.data;
        
        if(typeof this.uploadDir === 'object') {
            if(uploadTo && this.uploadDir[uploadTo]) {
                uploadDir = `${this.uploadDir[uploadTo]}`;
            }
            else {
                return sendError('cannot find upload directory: ' + uploadTo);
            }
        }
        else {
            uploadDir = `${this.uploadDir}`;
        }
        
		// Create a new Entry in The Files Variable
		files[fileName] = {
            id,
            size: data.size,
            data: '',
            uploaded: 0,
            path: uploadDir,
            abort: false,
            uploadTo,
            uploadData
        };

		let stream = 0;

		try {
            let stat = fs.statSync(`${uploadDir}/${fileName}`);

            if(stat.isFile()) {
                files[fileName].uploaded = stat.size;
                stream = stat.size / CHUNK_SIZE;
            }
        }
		// It's a New File
        catch(e) {}

        self.emit('start', data);

        fs.open(`${uploadDir}/${fileName}`, 'a', '0755', (err, fd) => {
            if(err) {
                return sendError('cannot find upload directory: ' + err);
            }
            else {
                files[fileName].fd = fd;	 //We store the file handler so we can write to it later

                const streamObj = {
					stream,
                    size: files[fileName].size,
					uploaded: 0,
					percent: 0
				};

                this.emit('stream', streamObj);
                socket.emit(`socket.io-file::${id}::stream`, streamObj);
            }
        });
	});

    this.socket.on('socket.io-file::abort', (data) => {
        let fileName = data.name;
        
        fs.unlink(`${files[fileName].path}/${fileName}`);
        files[fileName].abort = true;

        this.socket.emit(`socket.io-file::${id}::abort`, {});
    });

	this.socket.on('socket.io-file::stream', (data) => {
		let fileName = data.name;
        let id = data.id;

        if(files[fileName].abort) {
            delete files[fileName]; 
        }
        else {
            files[fileName].uploaded += data.data.length;
            files[fileName].data += data.data;

            // on fully uploaded
            if(files[fileName].uploaded == files[fileName].size) {
                fs.write(files[fileName].fd, files[fileName].data, null, 'Binary', (err, writen) => {
                    const streamObj = { 
                        stream,
                        size: files[fileName].size,
                        uploaded: files[fileName].size,
                        percent: (files[fileName].uploaded / files[fileName].size) * 100
                    };

                    this.emit('stream', streamObj);
                    this.emit('complete', {
                        name: fileName,
                        path: files[fileName].path,
                        uploadTo: files[fileName].uploadTo,
                        data: files[fileName].uploadData
                    });

                    socket.emit(`socket.io-file::${id}::stream`, streamObj);
                    socket.emit(`socket.io-file::${id}::complete`, {
                        name: fileName,
                        path: files[fileName].path,
                        uploadTo: files[fileName].uploadTo,
                        data: files[fileName].uploadData
                    });

                    delete files[fileName];
                });
            }
            // on reaches buffer limit
            else if(files[fileName].data.length > MAX_BUFFER_SIZE) {
                fs.write(files[fileName].fd, files[fileName].data, null, 'Binary', (err, writen) => {
                    files[fileName].data = '';		// clear the buffer

                    var stream = files[fileName].uploaded / CHUNK_SIZE;

                    const streamObj = { 
                        stream,
                        size: files[fileName].size,
                        uploaded: files[fileName].uploaded,
                        percent: (files[fileName].uploaded / files[fileName].size) * 100
                    };

                    this.emit('stream', streamObj);
                    socket.emit(`socket.io-file::${id}::stream`, streamObj);
                });
            }
            else {
                var stream = files[fileName].uploaded / CHUNK_SIZE;
                
                const streamObj = { 
                    stream,
                    size: files[fileName].size,
                    uploaded: files[fileName].uploaded,
                    percent: (files[fileName].uploaded / files[fileName].size) * 100
                };
                
                this.emit('stream', streamObj);
                socket.emit(`socket.io-file::${id}::stream`, streamObj);
            }
        }

	});
}
util.inherits(SocketIOFile, EventEmitter);

module.exports = SocketIOFile;