/**
 * WSDL import against a real SOAP stack (node-soap serving the same WSDL): each operation of the SOAP 1.1 and 1.2
 * ports becomes a request whose envelope the service accepts, with the sample built from the schema (complex types,
 * extension, enumerations, optional and repeated elements, attributes), and the request passes its checks.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { importWsdl } from '../src/api/wsdl';
import { allRequests } from '../src/api/model';
import { evaluateAll, prepare, send } from '../src/api/send';

const wsdl = (port: number) => `<?xml version="1.0" encoding="UTF-8"?>
<definitions name="OrderService" targetNamespace="http://shop.example/orders" xmlns="http://schemas.xmlsoap.org/wsdl/"
  xmlns:tns="http://shop.example/orders" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <types>
    <xsd:schema targetNamespace="http://shop.example/orders" elementFormDefault="qualified">
      <xsd:simpleType name="Priority"><xsd:restriction base="xsd:string"><xsd:enumeration value="NORMAL"/><xsd:enumeration value="EXPRESS"/></xsd:restriction></xsd:simpleType>
      <xsd:complexType name="Party"><xsd:sequence><xsd:element name="name" type="xsd:string"/><xsd:element name="email" type="xsd:string" minOccurs="0"/></xsd:sequence></xsd:complexType>
      <xsd:complexType name="Customer"><xsd:complexContent><xsd:extension base="tns:Party"><xsd:sequence><xsd:element name="customerId" type="xsd:int"/></xsd:sequence><xsd:attribute name="tier" type="xsd:string"/></xsd:extension></xsd:complexContent></xsd:complexType>
      <xsd:complexType name="Line"><xsd:sequence><xsd:element name="sku" type="xsd:string"/><xsd:element name="qty" type="xsd:int"/></xsd:sequence></xsd:complexType>
      <xsd:element name="PlaceOrderRequest"><xsd:complexType><xsd:sequence>
        <xsd:element name="customer" type="tns:Customer"/>
        <xsd:element name="line" type="tns:Line" maxOccurs="unbounded"/>
        <xsd:element name="priority" type="tns:Priority"/>
        <xsd:element name="deliverOn" type="xsd:date" minOccurs="0"/>
      </xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="PlaceOrderResponse"><xsd:complexType><xsd:sequence><xsd:element name="orderId" type="xsd:string"/><xsd:element name="total" type="xsd:decimal"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="GetStatusRequest"><xsd:complexType><xsd:sequence><xsd:element name="orderId" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="GetStatusResponse"><xsd:complexType><xsd:sequence><xsd:element name="status" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
    </xsd:schema>
  </types>
  <message name="PlaceOrderIn"><part name="parameters" element="tns:PlaceOrderRequest"/></message>
  <message name="PlaceOrderOut"><part name="parameters" element="tns:PlaceOrderResponse"/></message>
  <message name="GetStatusIn"><part name="parameters" element="tns:GetStatusRequest"/></message>
  <message name="GetStatusOut"><part name="parameters" element="tns:GetStatusResponse"/></message>
  <portType name="OrderPortType">
    <operation name="PlaceOrder"><documentation>Places an order.</documentation><input message="tns:PlaceOrderIn"/><output message="tns:PlaceOrderOut"/></operation>
    <operation name="GetStatus"><input message="tns:GetStatusIn"/><output message="tns:GetStatusOut"/></operation>
  </portType>
  <binding name="OrderBinding" type="tns:OrderPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="PlaceOrder"><soap:operation soapAction="http://shop.example/orders/PlaceOrder"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
    <operation name="GetStatus"><soap:operation soapAction="http://shop.example/orders/GetStatus"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
  </binding>
  <binding name="OrderBinding12" type="tns:OrderPortType">
    <soap12:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="PlaceOrder"><soap12:operation soapAction="http://shop.example/orders/PlaceOrder"/><input><soap12:body use="literal"/></input><output><soap12:body use="literal"/></output></operation>
    <operation name="GetStatus"><soap12:operation soapAction="http://shop.example/orders/GetStatus"/><input><soap12:body use="literal"/></input><output><soap12:body use="literal"/></output></operation>
  </binding>
  <service name="OrderService">
    <port name="OrderPort" binding="tns:OrderBinding"><soap:address location="http://127.0.0.1:${port}/orders"/></port>
    <port name="OrderPort12" binding="tns:OrderBinding12"><soap12:address location="http://127.0.0.1:${port}/orders12"/></port>
  </service>
</definitions>`;

test('WSDL import: operations of SOAP 1.1 and 1.2 ports, samples from the schema, accepted by a real SOAP service', async () => {
    const soap = await import('soap');
    const seen: unknown[] = [];
    const impl = {
        PlaceOrder: (args: { customer: { name: string; customerId: number }; line: Array<{ qty: number }> | { qty: number }; priority: string }) => {
            seen.push(args);
            const lines = Array.isArray(args.line) ? args.line : [args.line];
            if (!['NORMAL', 'EXPRESS'].includes(args.priority)) throw { Fault: { faultcode: 'soap:Client', faultstring: 'bad priority' } };
            return { orderId: `o-${args.customer.customerId}`, total: lines.reduce((n, l) => n + Number(l.qty), 0) * 10 };
        },
        GetStatus: (args: { orderId: string }) => ({ status: args.orderId === 'missing' ? 'UNKNOWN' : 'OPEN' }),
    };
    const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
    const port = await new Promise<number>((res) => server.listen(0, '127.0.0.1', () => res((server.address() as { port: number }).port)));
    const text = wsdl(port);
    soap.listen(server, '/orders', { OrderService: { OrderPort: impl } }, text);
    soap.listen(server, '/orders12', { OrderService: { OrderPort12: impl } }, text);
    try {
        const { collection: c, report } = importWsdl(text);
        assert.deepEqual([report.services, report.operations, report.warnings], [1, 4, []]);
        assert.equal(c.name, 'OrderService');
        assert.equal(c.baseUrl, `http://127.0.0.1:${port}`);
        const reqs = allRequests(c.items);
        assert.deepEqual(reqs.map((x) => `${x.folders[0]}/${x.request.name} ${x.request.url}`), [
            'OrderService · OrderPort (SOAP 1.1)/PlaceOrder /orders', 'OrderService · OrderPort (SOAP 1.1)/GetStatus /orders',
            'OrderService · OrderPort12 (SOAP 1.2)/PlaceOrder /orders12', 'OrderService · OrderPort12 (SOAP 1.2)/GetStatus /orders12']);
        const place = reqs[0].request;
        assert.deepEqual(place.headers.map((h) => `${h.key}: ${h.value}`), ['Content-Type: text/xml; charset=utf-8', 'SOAPAction: "http://shop.example/orders/PlaceOrder"']);
        assert.match(place.description!, /Places an order/);
        const xml = place.body.text!;
        assert.match(xml, /<ns1:customer tier="\{\{tier\}\}">\n\s+<ns1:name>\{\{name\}\}<\/ns1:name>\n\s+<!-- optional -->\n\s+<ns1:email>\{\{email\}\}<\/ns1:email>\n\s+<ns1:customerId>1<\/ns1:customerId>/, xml);
        assert.match(xml, /<!-- repeats -->\n\s+<ns1:line>/);
        assert.match(xml, /<ns1:priority>NORMAL<\/ns1:priority>/);
        assert.match(xml, /<ns1:deliverOn>2026-01-31<\/ns1:deliverOn>/);
        assert.match(reqs[2].request.headers[0].value, /^application\/soap\+xml; charset=utf-8; action="http:\/\/shop.example\/orders\/PlaceOrder"$/);
        // Sent as imported (placeholders filled from values): the service answers, the checks pass.
        const values = { vars: { name: 'Ada', email: 'ada@example.test', tier: 'gold', orderId: 'o-1' }, config: {}, env: {} };
        for (const { request: r } of reqs) {
            const res = await send(prepare(c, r, values), undefined, 5000);
            const v = await evaluateAll(r.checks, res, values);
            assert.ok(v.every((x) => x.pass), `${r.name} ${r.url}: ${res.status} ${res.body.slice(0, 500)} ${JSON.stringify(v)}`);
            assert.match(res.body, r.name === 'PlaceOrder' ? /<\w*:?orderId>o-1<\/\w*:?orderId>/ : /OPEN/);
        }
        assert.deepEqual((seen[0] as { customer: { name: string } }).customer.name, 'Ada');
        // A wrong value: the service's Fault fails the request's check.
        const bad = { ...place, body: { ...place.body, text: xml.replace('<ns1:priority>NORMAL', '<ns1:priority>SLOW') } };
        const res = await send(prepare(c, bad, values), undefined, 5000);
        assert.ok(!(await evaluateAll(bad.checks, res, values)).every((x) => x.pass));
        // Not WSDL 1.1.
        assert.throws(() => importWsdl('<description xmlns="http://www.w3.org/ns/wsdl"/>'), /WSDL 2.0/);
        assert.throws(() => importWsdl('<a/>'), /Not a WSDL 1.1/);
    } finally { server.close(); }
});
