
require("../lib/datamodel/SessionAuthenticationToken");


var CreateSessionResponse_Schema = {
    documentation: "Creates a new session with the server.",
    name: "CreateSessionResponse",
    fields: [
        { name:"responseHeader",                           fieldType:"ResponseHeader",                 documentation: "A standard header included in all responses returned by servers."},
        { name:"sessionId",                                fieldType:"NodeId",                         documentation: "A identifier which uniquely identifies the session."},
        { name:"authenticationToken",                      fieldType:"SessionAuthenticationToken",     documentation:"The token used to authenticate the client in subsequent requests."},
        { name:"revisedSessionTimeout",                    fieldType:"Duration",                       documentation: "The session timeout in milliseconds."},
        { name:"serverNonce",                              fieldType:"ByteString",                     documentation: "A random number generated by the server."},
        { name:"serverCertificate",                        fieldType:"ByteString",                     documentation: "The application certificate for the server."},
//xx        { name:"serverCertificate",                        fieldType:"ApplicationInstanceCertificate", documentation: "The application certificate for the server."},
        { name:"serverEndpoints",             isArray:true,fieldType:"EndpointDescription",            documentation: "The endpoints provided by the server."},
        { name:"serverSoftwareCertificates",  isArray:true,fieldType:"SignedSoftwareCertificate",      documentation: "The software certificates owned by the server."},
        { name:"serverSignature",                          fieldType:"SignatureData",                  documentation: "A signature created with the server certificate."},
        { name:"maxRequestMessageSize",                    fieldType:"UInt32",                         documentation: "The maximum message size accepted by the server."}

    ]
};
exports.CreateSessionResponse_Schema = CreateSessionResponse_Schema;